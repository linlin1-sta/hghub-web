# HGhub 网页版：构建前端 + 零依赖 Node 服务端
FROM node:22-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/web ./web
COPY --from=build /app/package.json ./package.json
EXPOSE 8080
CMD ["node", "web/server.mjs"]
