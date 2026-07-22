// 手动验证用的小工具：启动一个 mock server 并常驻，方便人工在真实终端里
// 测试 aizen-tui.exe（非交互模式或交互模式）时有一个可用的假后端，不需要
// 真实的 Anthropic API Key。用法：
//   bun run tests/utils/start-mock.ts "自定义响应文本"
import { startMockServer } from "./mock-server.ts"

const text = process.argv[2] ?? "架构可行性验证：Mock 链路通过"
const mock = await startMockServer(text)
console.log(`Mock server 已启动：${mock.url}`)
console.log(`响应内容：${text}`)
console.log("按 Ctrl+C 停止")
