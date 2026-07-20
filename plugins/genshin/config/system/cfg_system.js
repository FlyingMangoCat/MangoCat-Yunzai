/*
* 系统配置项定义
* */
export const cfgSchema = [
  {
    title: '渲染设置',
    cfg: {
      renderScale: {
        title: '渲染缩放',
        desc: '截图渲染缩放比例，默认100%',
        def: 100,
        key: 'renderScale'
      }
    }
  },
  {
    title: '显示设置',
    cfg: {
      commaGroup: {
        title: '数字分隔位数',
        desc: '数字千分位分隔位数，默认3位',
        def: 3,
        key: 'commaGroup'
      },
      qFace: {
        title: 'Q版头像',
        desc: '角色面板优先显示Q版头像',
        def: false,
        key: 'qFace'
      }
    }
  },
  {
    title: '数据设置',
    cfg: {
      notReleasedData: {
        title: '未上线角色',
        desc: '显示未上线角色数据',
        def: false,
        key: 'notReleasedData'
      }
    }
  }
]