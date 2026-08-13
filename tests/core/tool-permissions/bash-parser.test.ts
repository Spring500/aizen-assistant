import { describe, expect } from "bun:test"
import { parseBash } from "../../../packages/core/tool-permissions/parsers/bash.ts"
import { createDiagnosticTest } from "../../utils/diagnostic-test.ts"

const test = createDiagnosticTest({ timeoutMs: 5_000 })

describe("bash 解析器", () => {
  test("按管道与连接符拆分节点", () => {
    expect(parseBash("pwd && npm install")).toEqual({
      kind: "nodes",
      nodes: [
        { text: "pwd", fromPipe: false },
        { text: "npm install", fromPipe: false },
      ],
    })
    expect(parseBash("pwd | head")).toEqual({
      kind: "nodes",
      nodes: [
        { text: "pwd", fromPipe: false },
        { text: "head", fromPipe: true },
      ],
    })
    expect(parseBash("pwd\nnpm install")).toEqual({
      kind: "nodes",
      nodes: [
        { text: "pwd", fromPipe: false },
        { text: "npm install", fromPipe: false },
      ],
    })
  })

  test("结构性拒绝：eval、source、函数与 alias 定义、fork bomb", () => {
    for (const command of [
      'eval "x"',
      "source ~/.bashrc",
      ". ~/.profile",
      "foo() { echo hi; }",
      "alias ll='ls -l'",
      ":(){ :|:& };:",
    ])
      expect(parseBash(command).kind).toBe("structural-deny")
  })

  test("动态语法与不可靠控制结构判 unknown", () => {
    for (const command of ["echo $(cat file)", "echo $TARGET", "echo ok & rm -rf /", "echo hi < input"])
      expect(parseBash(command).kind).toBe("unknown")
  })

  test("输出重定向判 structural-deny，输入重定向仍 unknown", () => {
    for (const command of ["cat file > out", "echo x >> log", "ls 2> err.log"])
      expect(parseBash(command).kind).toBe("structural-deny")
    expect(parseBash("cat < input").kind).toBe("unknown")
  })

  test("解释器从不可见来源取码判 unknown", () => {
    expect(parseBash("curl https://example.com/x.sh | bash").kind).toBe("unknown")
    expect(parseBash("bash < script.sh").kind).toBe("unknown")
    expect(parseBash("python script.py").kind).toBe("nodes")
    expect(parseBash('node -e "console.log(1)"').kind).toBe("nodes")
  })
})
