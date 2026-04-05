# 项目配置说明

## package.json 配置详解

### 基本信息
- `name`: 项目名称 "MangoCat-Yunzai"
- `version`: 版本号 "3.1.3"
- `author`: 作者列表 "FlyingMangoCat,Yoimiya-Kokomi, Le-niao"
- `description`: 项目描述 "QQ group Bot"
- `main`: 主入口文件 "app.js"
- `type`: 模块类型 "module" (ES6模块)

### 脚本命令 (scripts)
- `app`: 启动应用 `node .`
- `dev`: 开发模式启动 `node . dev`
- `login`: 登录模式启动 `node . login`
- `web`: 启动Web服务 `node ./lib/tools/web.js`
- `test`: 运行测试 `node ./lib/tools/test.js`
- `start`: 使用PM2启动 `pm2 start ./config/pm2/pm2.json`
- `stop`: 停止PM2进程 `pm2 stop ./config/pm2/pm2.json`
- `restart`: 重启PM2进程 `pm2 restart ./config/pm2/pm2.json`
- `log`: 查看日志 `node ./lib/tools/log.js`
- `ksr`: 重启Redis服务 `node ./lib/tools/ksr.js`
- `lint`: 格式化代码 `prettier --write "**/*.js"`
- `lint-check`: 检查代码格式 `prettier --check "**/*.js"`

### 依赖项 (dependencies)
- `art-template`: 模板引擎，用于渲染HTML页面
- `chalk`: 终端字符串样式美化工具
- `chokidar`: 文件监听库，用于热更新
- `https-proxy-agent`: HTTPS代理代理
- `icqq`: QQ机器人核心库
- `image-size`: 获取图片尺寸信息
- `inquirer`: 命令行交互工具
- `lodash`: JavaScript工具库
- `log4js`: 日志记录库
- `md5`: MD5加密工具
- `moment`: 日期处理库
- `node-fetch`: Node.js的HTTP客户端
- `node-schedule`: 定时任务库
- `oicq`: QQ协议库(备用)
- `pm2`: 进程管理工具
- `puppeteer`: 浏览器自动化库，用于生成图片
- `redis`: Redis数据库客户端
- `sequelize`: ORM库，用于数据库操作
- `sqlite3`: SQLite数据库驱动
- `ws`: WebSocket库
- `yaml`: YAML解析库

### 开发依赖项 (devDependencies)
- `prettier`: 代码格式化工具

### 导入映射 (imports)
- `#yunzai`: 指向 `./lib/index.js`，提供核心API
- `#liulian`: 指向 `./plugins/liulian-plugin/components/index.js`，提供榴莲插件组件