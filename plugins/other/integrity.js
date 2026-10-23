import plugin from "../../lib/plugins/plugin.js";
import { ackIntegrityChanges } from "../../lib/config/integrityCheck.js";

/** 完整性自检确认：把当前本体差异按哈希记入台账，启动自检不再重复提醒 */
export class integrityAck extends plugin {
  constructor() {
    super({
      name: "完整性自检确认",
      dsc: "#自检确认",
      event: "message",
      priority: 4000,
      rule: [
        {
          reg: "^#自检确认$",
          fnc: "ack",
          permission: "master",
        },
      ],
    });
  }

  async ack() {
    const files = ackIntegrityChanges();
    if (!files.length) return this.reply("当前没有待确认的本体文件差异，无需确认");
    return this.reply(
      `已确认以下 ${files.length} 个文件的当前内容，启动自检不再提醒：\n${files.join("\n")}\n\n文件再次变更会重新提醒。`,
    );
  }
}
