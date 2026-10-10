import { Glob } from "bun";

const paths = await Array.fromAsync(new Glob("packages/*/package.json").scan());
const manifests = await Promise.all(paths.map(async (path) => ({ path, json: await Bun.file(path).json() })));
const versions = new Map(manifests.map(({ json }) => [json.name, json.version]));

for (const { path, json } of manifests) {
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const [name, range] of Object.entries<string>(json[field] ?? {})) {
      if (range.startsWith("workspace:")) json[field][name] = versions.get(name);
    }
  }
  await Bun.write(path, `${JSON.stringify(json, null, 2)}\n`);
}
