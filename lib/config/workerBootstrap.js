/**
 * worker_threads 守卫引导
 * 主线程 fsGuard.install() 通过 process.execArgv 注入 --import 本文件，
 * 使 Worker 子线程（其 fs 是独立模块实例，主线程的包装拦不到）同样安装 fsGuard。
 * 仅在 Worker 内被加载执行；主线程不会二次 import 本文件（--import 只对新 Node 执行上下文生效）。
 */
import "./fsGuard.js";
