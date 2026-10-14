# 组件接入边界

页面使用 React 19.3.0；3D 核心保留纯 TypeScript，不导入 React，也不发请求。

TwinSceneView 在 useEffect 中创建 TwinScene，卸载时 dispose；options 对象应由宿主 useMemo 保持稳定，frame 更新只调用 setFrame。容器必须有明确高度。

EChart 统一使用 yunqi-dark 主题，观察容器尺寸，卸载时释放图表。option 由宿主提供；提示框固定 richText。

Card、Title、DataSourceTag、Button、Table、ValueCell 各自独立。页面不用 innerHTML 或 dangerouslySetInnerHTML 拼装组件。

当前入口仅 Showcase，使用固定测试夹具；数据适配器与 Timeline 保留但未接入展示页。业务页、后端联调及 3D 运行验收待后续轮次。
