/** Browser fixture transport for the exact shared-service GUI methods. */
export async function invoke<T>(command:string,args?:Record<string,unknown>):Promise<T> {
  const path=command==="workbench_snapshot"?"snapshot":command==="workbench_replace_analyzers"?"replace":null;
  if (!path) throw new Error(`Unexpected fixture invoke: ${command}`);
  const response=await fetch(`/fixture/${path}`,path==="snapshot"?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(args?.request)});
  const value=await response.json();
  if (!response.ok) throw new Error(value.error ?? response.statusText);
  return value as T;
}
