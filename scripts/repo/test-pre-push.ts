const hook = Bun.file(".githooks/pre-push")
if (!(await hook.exists())) throw new Error("pre-push 钩子不存在")

const blocked = Bun.spawnSync({
  cmd: ["sh", ".githooks/pre-push"],
  stdin: new TextEncoder().encode("refs/heads/main a refs/heads/main b\n"),
  env: process.env,
})
if (blocked.exitCode === 0) throw new Error("main 推送未被阻止")

const allowed = Bun.spawnSync({
  cmd: ["sh", ".githooks/pre-push"],
  stdin: new TextEncoder().encode("refs/heads/feat/demo a refs/heads/feat/demo b\n"),
  env: process.env,
})
if (allowed.exitCode !== 0) throw new Error("功能分支推送被错误阻止")

console.log("pre-push 钩子检查通过")
