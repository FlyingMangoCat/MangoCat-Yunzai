import { Sequelize, DataTypes, Model } from "sequelize"
import cfg from "../../../../lib/config/config.js"
import path from "node:path"
import fs from "node:fs/promises"

if (cfg.db.dialect === "sqlite") await fs.mkdir(path.dirname(cfg.db.storage), { recursive: true })
const sequelize = new Sequelize(cfg.db)

try {
  await sequelize.authenticate()
} catch (err) {
  logger?.error?.("数据库认证错误", err)
}

export default class BaseModel extends Model {
  static Types = DataTypes

  static initDB(model, columns) {
    let name = model.name
    name = name.replace(/DB$/, "s")
    model.init(columns, { sequelize, tableName: name })
    model.COLUMNS = columns
  }

  /**
   * 同步表结构并对已存在的表补齐缺失列（ALTER TABLE ADD COLUMN）
   * Sequelize 默认 sync 只创建缺失的表，不会给已存在的表加列
   * @param {Model} model 已通过 initDB 初始化的模型
   */
  static async syncWithAlter(model) {
    await model.sync()
    const tableName = model.getTableName()
    const queryInterface = sequelize.getQueryInterface()
    // 取已存在表的实际列描述
    let actualCols
    try {
      actualCols = await queryInterface.describeTable(tableName)
    } catch (err) {
      // 表不存在（首次创建），sync() 已建表，无需补列
      return
    }
    // 遍历模型定义的字段，对缺失列逐一 ADD COLUMN
    for (const [col, def] of Object.entries(model.getAttributes())) {
      if (actualCols[col]) continue
      try {
        await queryInterface.addColumn(tableName, col, {
          type: def.type,
          allowNull: def.allowNull ?? true,
          defaultValue: def.defaultValue,
        })
        logger?.mark?.(`[DB] ${tableName} 补列: ${col}`)
      } catch (err) {
        logger?.error?.(`[DB] ${tableName} 补列失败 ${col}:`, err)
      }
    }
  }
}
export { sequelize }