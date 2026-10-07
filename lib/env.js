// 从项目根目录加载 .env（与启动时的工作目录无关）；已存在的环境变量优先
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (fs.existsSync(file)) process.loadEnvFile(file);
