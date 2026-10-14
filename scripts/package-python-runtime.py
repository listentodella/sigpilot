#!/usr/bin/env python3
"""Bundle the current CPython, never fetch binaries. Run with the build Python."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import sysconfig


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT)


def fail(message):
    raise RuntimeError(message)


def check_build(build):
    cache = build / "CMakeCache.txt"
    if not cache.is_file():
        fail(f"Missing {cache}; cannot establish the Sigrok Python ABI")
    text = cache.read_text()
    libraries = re.findall(r"^(?:_?Python3_LIBRARY_RELEASE|_Python3_LIBRARIES):[^=]*=(.+)$", text, re.M)
    if not libraries:
        fail("CMake did not record a shared Python library; rebuild with SIGPILOT_SIGROK_PYTHON_ROOT")
    framework = sysconfig.get_config_var("PYTHONFRAMEWORK")
    expected = (Path(sys.base_prefix) / framework if framework else
                Path(sysconfig.get_config_var("LIBDIR")) / sysconfig.get_config_var("LDLIBRARY"))
    candidates = [expected]
    if os.name == "nt":
        # MinGW CMake may record an import library (.dll.a) or the DLL itself.
        libdir = Path(sysconfig.get_config_var("LIBDIR") or Path(sys.base_prefix) / "lib")
        candidates = [libdir / name for name in (sysconfig.get_config_var("LIBRARY"), sysconfig.get_config_var("LDLIBRARY")) if name]
        candidates += list(libdir.glob(f"*python{sys.version_info.major}.{sys.version_info.minor}*.dll.a"))
        expected = candidates[0] if candidates else expected
    if not any(Path(value.split(";")[0]).resolve() == candidate.resolve() for value in libraries for candidate in candidates):
        fail(f"Sigrok CMake Python library {libraries} does not match {sys.executable} ({expected}); rebuild with the matching Python root")
    binary = build / ("sigpilot-sigrok-sidecar.exe" if os.name == "nt" else "sigpilot-sigrok-sidecar")
    if not binary.is_file():
        fail(f"Missing Sigrok build executable: {binary}")
    if sys.platform == "darwin":
        links = [Path(line.strip().split(" (", 1)[0]) for line in run("otool", "-L", str(binary)).splitlines()[1:]]
        if expected.resolve() not in [path.resolve() for path in links]:
            fail("Sigrok executable does not link the selected CPython framework/library; rebuild it")
    elif sys.platform == "linux":
        links = [Path(path).resolve() for path in re.findall(r"=> (/\S+)", run("ldd", str(binary)))]
        if expected.resolve() not in links:
            fail("Sigrok executable does not link the selected shared libpython; rebuild it")
    elif os.name == "nt":
        imports = run("objdump", "-p", str(binary)).lower()
        version = f"{sys.version_info.major}.{sys.version_info.minor}"
        names = re.findall(r"dll name:\s*(\S*python\S*)", imports)
        if not names or any(version not in name and version.replace('.', '') not in name for name in names):
            fail("Sigrok executable Python DLL does not match the build interpreter; rebuild it")
    return expected

def copy_tree(source, target):
    shutil.copytree(source, target, symlinks=False, ignore=shutil.ignore_patterns(
        "site-packages", "dist-packages", "__pycache__", "*.pyc", "*.pyo", "config-*", "test", "tests", "idlelib", "tkinter", "_tkinter*", "turtledemo", "ensurepip"))


class Dependencies:
    def __init__(self, root, python_lib):
        self.root = root
        self.lib = root / "python-runtime" / ("bin" if os.name == "nt" else "lib")
        self.mapping = {}
        self.visited = set()
        self.python_lib = python_lib.resolve()

    def copy(self, source):
        requested_name = source.name
        source = source.resolve()
        if source in self.mapping:
            target = self.mapping[source]
            self.alias(requested_name, target)
            return target
        target = self.lib / source.name
        if target.exists() and target.read_bytes() != source.read_bytes():
            fail(f"Dependency basename collision: {source} and {target}")
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            shutil.copy2(source, target)
        target.chmod(0o755)
        self.mapping[source] = target
        self.visit(source, target)
        self.alias(requested_name, target)
        return target

    def alias(self, name, target):
        # ELF DT_NEEDED names commonly refer to a SONAME symlink, not the
        # versioned file realpath. Keep that name with a package-relative link.
        alias = self.lib / name
        if sys.platform == "linux" and alias != target and not alias.exists():
            alias.symlink_to(target.name)

    def visit(self, source, target):
        key = (source.resolve(), target)
        if key in self.visited:
            return
        self.visited.add(key)
        target.chmod(0o755)
        if sys.platform == "darwin":
            lines = run("otool", "-L", str(source)).splitlines()[1:]
            load = run("otool", "-l", str(source))
            rpaths = re.findall(r"cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset", load)
            ids = run("otool", "-D", str(source)).splitlines()[1:]
            for line in lines:
                dep = line.strip().split(" (", 1)[0]
                if dep.startswith(("/System/Library/", "/usr/lib/")):
                    continue
                if dep == source.as_posix() or dep in ids:  # dylib install id
                    continue
                candidates = []
                if dep.startswith("@rpath/"):
                    for rpath in rpaths:
                        candidates.append(Path(rpath.replace("@loader_path", str(source.parent)).replace("@executable_path", str(Path(sys.executable).resolve().parent))) / dep[7:])
                else:
                    candidates.append(Path(dep.replace("@loader_path", str(source.parent)).replace("@executable_path", str(Path(sys.executable).resolve().parent))))
                resolved = next((p for p in candidates if p.is_file()), None)
                if resolved is None:
                    fail(f"Cannot resolve Mach-O dependency {dep} of {source}")
                bundled = self.copy(resolved)
                replacement = "@loader_path/" + os.path.relpath(bundled, target.parent)
                run("install_name_tool", "-change", dep, replacement, str(target))
            for rpath in rpaths:
                if rpath.startswith("/"):
                    run("install_name_tool", "-delete_rpath", rpath, str(target))
            if target.suffix == ".dylib" or source.resolve() == self.python_lib:
                run("install_name_tool", "-id", "@loader_path/" + target.name, str(target))
            run("codesign", "--force", "--sign", "-", str(target))
        elif sys.platform == "linux":
            output = run("ldd", str(source))
            if "not found" in output:
                fail(f"Unresolved ELF dependency in {source}: {output}")
            for dep in re.findall(r"=> (/\S+)", output):
                if re.match(r"(?:ld-linux|lib(?:c|m|dl|pthread|rt|resolv|util)\.so\.)", Path(dep).name):
                    continue
                self.copy(Path(dep))
            relative = os.path.relpath(self.lib, target.parent)
            soname = run("patchelf", "--print-soname", str(target)).strip()
            if soname and target.parent == self.lib:
                self.alias(soname, target)
            run("patchelf", "--set-rpath", "$ORIGIN:" + "$ORIGIN/" + relative, str(target))
        elif os.name == "nt":
            output = run("objdump", "-p", str(source))
            search = [Path(sys.executable).parent, Path(sys.base_prefix) / "bin", Path(sys.base_prefix)]
            for name in re.findall(r"DLL Name:\s*(\S+)", output):
                dep = next((p / name for p in search if (p / name).is_file()), None)
                if dep:
                    self.copy(dep)
                elif not (name.lower().startswith(("api-ms-", "ext-ms-")) or (Path(os.environ["SystemRoot"]) / "System32" / name).is_file()):
                    fail(f"Unresolved DLL {name} of {source}")


def package(root, build):
    expected = check_build(build)
    if sys.platform == "linux" and not shutil.which("patchelf"):
        fail("patchelf is required for relocatable Linux Python/extension dependencies")
    runtime = root / "python-runtime"
    if runtime.exists():
        shutil.rmtree(runtime)
    (runtime / "bin").mkdir(parents=True)
    version = f"{sys.version_info.major}.{sys.version_info.minor}"
    stdlib = Path(sysconfig.get_path("stdlib"))
    # Native Windows CPython uses Lib/DLLs; MinGW uses lib/pythonX.Y.
    native_windows = os.name == "nt" and sysconfig.get_platform().startswith("win")
    library_target = runtime / ("Lib" if native_windows else f"lib/python{version}")
    copy_tree(stdlib, library_target)
    dynload = Path(sysconfig.get_config_var("DESTSHARED") or (Path(sys.base_prefix) / "DLLs"))
    if dynload.is_dir() and not (library_target / "lib-dynload").exists():
        copy_tree(dynload, runtime / "DLLs" if native_windows else library_target / "lib-dynload")
    executable = runtime / "bin" / ("python.exe" if os.name == "nt" else "python3")
    interpreter = Path(sys.executable).resolve()
    if sys.platform == "darwin" and sysconfig.get_config_var("PYTHONFRAMEWORK"):
        # Framework bin/python is a launcher that execs Python.app at an absolute
        # build path. Bundle the real console-capable app executable instead.
        app = Path(sys.base_prefix) / "Resources/Python.app/Contents/MacOS/Python"
        if not app.is_file():
            fail(f"Framework interpreter was not found at {app}")
        interpreter = app.resolve()
    shutil.copy2(interpreter, executable)
    deps = Dependencies(root, expected)
    if os.name == "nt":
        dlls = [path for directory in (Path(sys.executable).parent, Path(sys.base_prefix), Path(sys.base_prefix) / "bin")
                for path in directory.glob("*python*.dll")
                if version in path.name or version.replace('.', '') in path.name]
        if not dlls:
            fail("Cannot locate the build Python runtime DLL")
        for dll in dlls:
            deps.copy(dll)
    else:
        deps.copy(expected)
    deps.visit(interpreter, executable)
    for path in sorted(runtime.rglob("*")):
        if path.is_file() and not path.is_symlink() and path.parent != deps.lib and path.suffix in (".so", ".dylib", ".pyd", ".dll") and path not in deps.mapping.values():
            # Its original location is needed to resolve extension rpaths.
            rel = path.relative_to(library_target) if path.is_relative_to(library_target) else None
            original = stdlib / rel if rel is not None else dynload / path.name
            if not original.exists():
                original = dynload / path.name
            deps.visit(original, path)
    sigrok = root / "sigrok-analyzer-sidecar"
    for path in sorted(sigrok.rglob("*")):
        if path.is_file() and (path.name.startswith("sigpilot-sigrok-sidecar") or path.suffix in (".so", ".dylib", ".dll")):
            original = build / path.relative_to(sigrok)
            if original.is_file():
                deps.visit(original, path)
    # Do not retain a second Python DLL copied by the old Windows build helper.
    if os.name == "nt":
        for path in sigrok.glob("*python*.dll"):
            path.unlink()
    metadata = {"version": sys.version.split()[0], "implementation": sys.implementation.name,
                "stdlib": library_target.relative_to(runtime).as_posix(), "shared_library": next((p.relative_to(runtime).as_posix() for s, p in deps.mapping.items() if s == expected.resolve() or (os.name == "nt" and "python" in s.name.lower())), "")}
    (runtime / "runtime.json").write_text(json.dumps(metadata, indent=2) + "\n")
    for license_source in (Path(sys.base_prefix) / "LICENSE.txt", stdlib / "LICENSE.txt", Path(sys.base_prefix) / "LICENSE"):
        if license_source.is_file():
            shutil.copy2(license_source, runtime / "LICENSE.txt")
            break
    env = dict(os.environ, PYTHONHOME=str(runtime), PYTHONDONTWRITEBYTECODE="1")
    env.pop("PYTHONPATH", None)
    for name in ("DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH", "LD_LIBRARY_PATH"):
        env.pop(name, None)
    env["PATH"] = str(runtime / "bin") + os.pathsep + env.get("PATH", "")
    subprocess.run([str(executable), "-s", "-c", "import sys, encodings, json, ssl, sqlite3, ctypes, zlib; assert sys.version.split()[0] == " + repr(metadata["version"])], env=env, check=True)
    print(f"Shared CPython {metadata['version']}: {sum(p.stat().st_size for p in runtime.rglob('*') if p.is_file())} bytes")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("build", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        if sys.implementation.name != "cpython":
            fail("Only CPython is supported")
        if args.check:
            check_build(args.build)
        else:
            package(args.root.resolve(), args.build.resolve())
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f"Python runtime packaging failed: {error}", file=sys.stderr)
        sys.exit(1)
