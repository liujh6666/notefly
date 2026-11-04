/*
 * 阿里普惠体 3.0 子集化脚本
 * ---------------------------------------------------------------------------
 * 桌面版必须完全离线可用，所以字体要落到 public/fonts/，而不是运行时外链。
 * 普惠体全量 woff2 每个字重 5.2MB，四个字重直接塞进包里会让安装包臃肿不可接受，
 * 因此这里做两件事：
 *   1. 从 jsDelivr 下载官方发布的 woff2（Regular / Medium / SemiBold / Bold）
 *   2. 用 fontTools 子集化成「GB2312 全字表 + 常用符号 + 拉丁」，体积降到 1/5 左右
 *
 * 用法：node scripts/fetch-puhuiti.js
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FONT_DIR = path.join(ROOT, "public", "fonts");
const OUT_DIR = path.join(FONT_DIR, "aph");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notefly-puhuiti-"));
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/* 阿里普惠体 3.0（阿里巴巴免费商用字体），经 npm 镜像分发 */
const BASE = "https://cdn.jsdelivr.net/npm";
const JOBS = [
  { file: "AlibabaPuHuiTi-3-55-Regular.woff2", weight: 400, pkg: "alibabapuhuiti-3-55-regular@1.0.0" },
  { file: "AlibabaPuHuiTi-3-65-Medium.woff2", weight: 500, pkg: "alibabapuhuiti-3-65-medium@1.0.0" },
  { file: "AlibabaPuHuiTi-3-75-SemiBold.woff2", weight: 600, pkg: "alibabapuhuiti-3-75-semibold@1.0.0" },
  { file: "AlibabaPuHuiTi-3-85-Bold.woff2", weight: 700, pkg: "alibabapuhuiti-3-85-bold@1.0.0" },
];

function get(url, binary) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(res.headers.location, binary));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error("HTTP " + res.statusCode + " " + url));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.setTimeout(90000, () => req.destroy(new Error("超时 " + url)));
  });
}

/* 码位表：GB2312 全区（6763 汉字 + 全角符号）+ 拉丁 + 常用标点/箭头/几何/数学
   写成十六进制文本交给 fontTools，避免命令行长度限制 */
function buildCodepointFile() {
  const py = `
import json
chars = set()
for c in range(0x20, 0x7F):
    chars.add(chr(c))
for c in range(0xA0, 0x100):
    chars.add(chr(c))
for hi in range(0xA1, 0xFF):
    for lo in range(0xA1, 0xFF):
        try:
            chars.add(bytes([hi, lo]).decode("gb2312"))
        except Exception:
            pass
ranges = [
    (0x2000, 0x206F), (0x2070, 0x209F), (0x20A0, 0x20BF),
    (0x2100, 0x214F), (0x2190, 0x21FF), (0x2200, 0x22FF),
    (0x2460, 0x24FF), (0x2500, 0x257F), (0x25A0, 0x25FF),
    (0x2600, 0x26FF), (0x3000, 0x303F), (0x3105, 0x312F),
    (0xFE10, 0xFE1F), (0xFE30, 0xFE4F), (0xFF00, 0xFFEF),
]
for a, b in ranges:
    for c in range(a, b + 1):
        chars.add(chr(c))
print(json.dumps(sorted(ord(c) for c in chars)))
`;
  const out = execFileSync("python", ["-c", py], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const codes = JSON.parse(out);
  const file = path.join(TMP, "unicodes.txt");
  fs.writeFileSync(file, codes.map((c) => c.toString(16).toUpperCase()).join("\n") + "\n");
  return { file, count: codes.length };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { file: uniFile, count } = buildCodepointFile();
  console.log("字符集：" + count + " 个码位");

  const faces = [];
  for (const job of JOBS) {
    const raw = path.join(TMP, job.file);
    if (!fs.existsSync(raw) || fs.statSync(raw).size < 100000) {
      const url = BASE + "/" + job.pkg + "/" + job.file;
      console.log("下载 " + job.file + " …");
      const buf = await get(url, true);
      fs.writeFileSync(raw, buf);
      console.log("  原始 " + (buf.length / 1048576).toFixed(2) + " MB");
    }

    const out = path.join(OUT_DIR, job.file);
    console.log("子集化 " + job.file + " …");
    execFileSync("python", [path.join(__dirname, "font-subset.py"), raw, out, uniFile], {
      stdio: ["ignore", "ignore", "inherit"],
      maxBuffer: 256 * 1024 * 1024,
    });
    console.log("  子集 " + (fs.statSync(out).size / 1048576).toFixed(2) + " MB");

    faces.push(
      "@font-face {\n" +
      "  font-family: 'Alibaba PuHuiTi';\n" +
      "  font-style: normal;\n" +
      "  font-weight: " + job.weight + ";\n" +
      "  font-display: swap;\n" +
      "  src: url(aph/" + job.file + ") format('woff2');\n" +
      "}"
    );
  }

  const header =
    "/* NoteFly 自托管字体 · 阿里巴巴普惠体 3.0（免费商用）\n" +
    "   由 scripts/fetch-puhuiti.js 生成：下载官方 woff2 → 按 GB2312 全字表子集化\n" +
    "   请勿手工修改。字体版权：© 阿里巴巴（中国）有限公司 */\n\n";
  fs.writeFileSync(path.join(FONT_DIR, "puhuiti.css"), header + faces.join("\n\n") + "\n");
  console.log("完成 → public/fonts/puhuiti.css");
})().catch((e) => {
  console.error("普惠体处理失败：", e.message);
  process.exit(1);
});
