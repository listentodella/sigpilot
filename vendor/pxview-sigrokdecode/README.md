PXView SigrokDecode Subset
==========================

This directory vendors the PXView source subset used by PXLogic's native
sigrok sidecar:

- `libsigrokdecode/`
- `common/`

It intentionally excludes the rest of the PXView application tree and generated
artifacts such as `__pycache__`, `.pyc`, object files and prebuilt shared
libraries. The native sidecar builds the C decoders for each target platform
during packaging and copies the Python decoder sources into the app resources.

Source snapshot: local PXView fork commit
`8be58dea74acc300b772915b3adc368691db3075`.

License files are preserved in the vendored source tree.
