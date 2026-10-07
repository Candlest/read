# 论文阅读器：Web 界面 + REST API + MCP（Streamable HTTP）
# MinerU / PaddleOCR 建议作为独立服务部署，通过 MINERU_API_URL / PADDLEOCR_API_URL 接入
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5178 \
    READ_DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
VOLUME /data
EXPOSE 5178
# 非本机监听时服务端要求设置 READ_TOKEN
CMD ["node", "--no-warnings", "server.js"]
