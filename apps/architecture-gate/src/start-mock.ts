import { startMockServer } from "./mock-server.ts"

const text = process.argv[2] ?? "架构门禁 Mock 链路通过"
const mock = startMockServer(text)
console.log(`Mock server 已启动：${mock.url}`)
console.log(`响应内容：${text}`)
console.log("按 Ctrl+C 停止")
