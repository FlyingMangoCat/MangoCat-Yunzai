import Renderer from "./Renderer.js";

export default new Proxy(
  {},
  {
    get(_, property) {
      return Renderer[property];
    },
  },
);
