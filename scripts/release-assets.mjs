import fs from "node:fs";
import path from "node:path";

const iconSpecs = [
  ["icp4", "assets/favicon-16.png"],
  ["icp5", "assets/favicon-32.png"],
  ["icp6", "assets/app-icon-64.png"],
  ["ic07", "assets/app-icon-128.png"],
  ["ic08", "assets/app-icon-256.png"],
  ["ic09", "assets/app-icon-512.png"],
  ["ic10", "assets/app-icon-1024.png"],
];

export function createIcns(projectRoot, targetIconPath) {
  const chunks = iconSpecs.map(([type, relativePath]) => {
    const png = fs.readFileSync(path.join(projectRoot, relativePath));
    const chunk = Buffer.alloc(8 + png.length);
    chunk.write(type, 0, 4, "ascii");
    chunk.writeUInt32BE(chunk.length, 4);
    png.copy(chunk, 8);
    return chunk;
  });
  const totalLength = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(totalLength, 4);
  fs.mkdirSync(path.dirname(targetIconPath), { recursive: true });
  fs.writeFileSync(targetIconPath, Buffer.concat([header, ...chunks], totalLength));
  return targetIconPath;
}
