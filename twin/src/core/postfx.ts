import * as T from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
export function postfx(
  renderer: T.WebGLRenderer,
  scene: T.Scene,
  camera: T.Camera,
) {
  // Renderer antialias only covers the default framebuffer, not composer targets.
  const size = renderer.getSize(new T.Vector2());
  const target = new T.WebGLRenderTarget(size.x, size.y, {
    type: T.HalfFloatType,
    samples: 4,
  });
  const composer = new EffectComposer(renderer, target);
  const render = new RenderPass(scene, camera),
    bloom = new UnrealBloomPass(new T.Vector2(1, 1), 0.45, 0.4, 0.8);
  const tone = new ShaderPass({
    uniforms: { tDiffuse: { value: null } },
    vertexShader:
      "varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
    fragmentShader:
      "uniform sampler2D tDiffuse;varying vec2 vUv;void main(){vec3 x=texture2D(tDiffuse,vUv).rgb;vec3 c=clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.);vec3 srgb=mix(c*12.92,1.055*pow(c,vec3(1./2.4))-.055,step(vec3(.0031308),c));gl_FragColor=vec4(srgb,1.);}",
  });
  composer.addPass(render);
  composer.addPass(bloom);
  composer.addPass(tone);
  return {
    composer,
    bloom,
    async compileAsync() {
      // Composer shaders are not part of the main scene traversal.
      const geometries = new T.PlaneGeometry(2, 2);
      const materials = [
        tone.material,
        composer.copyPass.material,
        bloom.materialHighPassFilter,
        ...bloom.separableBlurMaterials,
        bloom.compositeMaterial,
        bloom.blendMaterial,
      ];
      try {
        for (const material of materials) {
          const stage = new T.Scene();
          stage.add(new T.Mesh(geometries, material));
          await renderer.compileAsync(
            stage,
            new T.OrthographicCamera(-1, 1, 1, -1, 0, 1),
          );
        }
      } finally {
        geometries.dispose();
      }
    },
    dispose() {
      bloom.dispose();
      tone.dispose();
      composer.dispose();
    },
  };
}
