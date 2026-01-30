# =============================================================================
# AgentStudio Backend Dockerfile
# =============================================================================

# 使用完整 Debian 镜像，避免 Alpine 缺少依赖问题
FROM node:20-slim

# 安装必要依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    curl \
    git \
    wget \
    ca-certificates \
    procps \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# 安装 uv (Python 包管理器，提供 uvx 命令用于 MCP 服务器)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"

# 安装 Python 依赖（xlsx skill 需要 openpyxl）
RUN pip3 install --no-cache-dir --break-system-packages openpyxl

# 安装 pnpm
ENV PNPM_VERSION=10.18.1
RUN npm install -g pnpm@${PNPM_VERSION}

WORKDIR /app

# 复制 workspace 配置
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

# 复制 workspace 模块 (注意：项目没有 shared 目录)
COPY backend ./backend

# 安装依赖
RUN pnpm install --frozen-lockfile

# 构建 backend
RUN pnpm --filter agentstudio-backend run build

# 创建数据目录（运行时会从宿主机挂载）
RUN mkdir -p /root/.claude-agent /root/.agent-studio /root/.claude

WORKDIR /app/backend

# 默认端口
ENV PORT=4936
ENV HOST=0.0.0.0

EXPOSE 4936

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -q --spider http://localhost:4936/api/health || exit 1

CMD ["node", "dist/index.js"]
