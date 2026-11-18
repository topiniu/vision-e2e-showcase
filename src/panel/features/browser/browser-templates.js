export const payloadTemplates = [
  {
    id: "login-click",
    title: "点击登录页签",
    description: "单步 click payload，适合检查语义匹配是否正常。",
    payload: {
      type: "click",
      target: {
        text: "账号登陆",
      },
      needRes: true,
    },
  },
  {
    id: "username-type",
    title: "输入账号",
    description: "单步 type payload，预填常见测试账号。",
    payload: {
      type: "type",
      target: {
        text: "账号",
        value: "DEMO_USER",
      },
      needRes: true,
    },
  },
  {
    id: "login-flow",
    title: "登录链路",
    description: "三步登录流程，附带欢迎文案断言。",
    payload: [
      {
        type: "click",
        target: { text: "账号登陆" },
        needRes: true,
      },
      {
        type: "type",
        target: { text: "账号", value: "DEMO_USER" },
        needRes: true,
      },
      {
        type: "click",
        target: { text: "登录" },
        waitForChange: true,
        expectation: {
          type: "text-exists",
          text: "欢迎回来",
          timeoutMs: 6000,
        },
        needRes: true,
      },
    ],
  },
];
