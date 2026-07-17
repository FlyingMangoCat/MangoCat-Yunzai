import EventListener from "../listener/listener.js";

/**
 * 监听群聊消息
 */
export default class messageEvent extends EventListener {
  constructor() {
    super({ event: "message" });
  }

  async execute(e) {
    try {
      await this.plugins.deal(e);
    } catch (err) {
      logger.error(`消息处理错误：${err.message}`);
      logger.error(err.stack);
    }
  }
}
