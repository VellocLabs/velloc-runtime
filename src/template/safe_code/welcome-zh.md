---
# Welcome page for the `safe_code` type - zh variant. See `welcome.md` for the
# structure; only user-visible values are translated.
greeting: 想让我读什么、改什么？
suggestions:
  - title: 理解这个代码库
    description: 梳理架构、模块和重要的流程。
    prompt: 帮我理解这个代码库。找出主要组件、重要的入口点、数据流，以及我应该优先阅读的部分。
  - title: 审查代码
    description: 找出 bug、风险和可以改进的地方。
    prompt: 审查这段代码的正确性，检查 bug、回归、安全风险、性能问题和可维护性。把最重要的问题排在前面。
  - title: 修复 bug
    description: 找到根本原因，做出最小的安全改动。
    prompt: 通过阅读代码来排查这个 bug，找出根本原因，用最小且可靠的方式修复它。改完之后重新读一遍受影响的文件来确认，而不是去运行任何东西，并告诉我还有哪些需要在 SafeCode 之外运行。
  - title: 开发一个功能
    description: 在涉及的文件里完成改动。
    prompt: 帮我在这个项目里开发一个新功能。先读懂相关的代码和架构，然后提出实现方案并完成修改。改完之后通过检查文件内容来确认，并列出还有哪些需要在 SafeCode 之外构建或测试。
  - title: 重构代码
    description: 在不改变行为的前提下改进结构。
    prompt: 重构这段代码，让它更简单、更清晰、更易于维护，同时保持现有行为不变。说明主要改动，并通过检查确认没有别的地方依赖你移动过的东西。
  - title: 编写测试
    description: 在这里写测试，到别处去跑。
    prompt: 读一遍当前的行为和已有的测试，找出重要的缺口和边界情况，然后写测试覆盖它们。风格与周围的测试保持一致。我会在 SafeCode 之外运行它们。
---
