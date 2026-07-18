import { Sequelize, DataTypes, Model } from "sequelize"
import cfg from "../../../../lib/config/config.js"
import path from "node:path"
import fs from "node:fs/promises"

let sequelize = false

try {
  if (cfg.db.dialect === "sqlite") await fs.mkdir(path.dirname(cfg.db.storage), { recursive: true })
  sequelize = new Sequelize(cfg.db)
  await sequelize.authenticate()
} catch (err) {
  logger?.error?.("数据库初始化失败，将降级使用文件存储", err.message)
  sequelize = false
}

export default class BaseModel extends Model {
  static Types = DataTypes

  static initDB(model, columns) {
    if (!sequelize) return
    let name = model.name
    name = name.replace(/DB$/, "s")
    model.init(columns, { sequelize, tableName: name })
    model.COLUMNS = columns
  }
}
export { sequelize }
