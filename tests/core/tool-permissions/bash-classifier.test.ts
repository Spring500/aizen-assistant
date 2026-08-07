import { describe, expect, test } from "bun:test"
import { createBuiltinBashClassifier } from "../../../packages/core/tool-permissions/classifiers/bash.ts"

const classifier = createBuiltinBashClassifier()
const context = {
  workspaceRoot: "/project",
  homeDirectory: "/home/user",
  sensitivePaths: [],
  shell: "bash",
  platform: "linux",
}

async function classify(command: string) {
  return classifier.classify({ toolName: "bash", command, arguments: { command }, cwd: "/project" }, context)
}

function tags(result: Awaited<ReturnType<typeof classify>>) {
  return result.kind === "claims" ? result.claims.map((claim) => claim.tag) : []
}

describe("内置 Bash 分类器", () => {
  test("npm install 声称下载和工作区写入", async () => {
    expect(tags(await classify("npm install"))).toEqual(["network-fetch", "edit-workspace"])
    expect(tags(await classify("npm i lodash"))).toEqual(["network-fetch", "edit-workspace"])
  })

  test("npm ci、update 和 uninstall 声称对应行为", async () => {
    expect(tags(await classify("npm ci"))).toEqual(["network-fetch", "edit-workspace"])
    expect(tags(await classify("npm update"))).toEqual(["network-fetch", "edit-workspace"])
    expect(tags(await classify("npm uninstall lodash"))).toEqual(["edit-workspace"])
  })

  test("npm publish 声称网络发送", async () => {
    expect(tags(await classify("npm publish"))).toEqual(["network-send"])
  })

  test("npm --prefix 根据静态路径推导写入作用域", async () => {
    expect(tags(await classify("npm --prefix /home/user/tools install x"))).toEqual(["network-fetch", "edit-home"])
    expect(tags(await classify("npm --prefix /opt/tools install x"))).toEqual(["network-fetch", "edit-system"])
  })

  test("动态语法和未覆盖命令弃权", async () => {
    expect(await classify("npm --prefix $TARGET install x")).toEqual({ kind: "abstain" })
    expect(await classify("git status")).toEqual({ kind: "abstain" })
  })
})
