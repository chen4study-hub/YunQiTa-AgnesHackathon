import * as T from "three";
export function world(count: number) {
  const group = new T.Group();
  const ground = new T.Mesh(
    new T.PlaneGeometry(600, 600),
    new T.MeshStandardMaterial({ color: 0x14232b, roughness: 0.85 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);
  const plaza = new T.Mesh(
    new T.CylinderGeometry(24, 24, 0.2, 64),
    new T.MeshStandardMaterial({ color: 0x344650, roughness: 0.65 }),
  );
  plaza.position.y = 0.1;
  plaza.receiveShadow = true;
  group.add(plaza);
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#172b37";
  ctx.fillRect(0, 0, 64, 128);
  for (let y = 4; y < 128; y += 10)
    for (let x = 4; x < 64; x += 9) {
      ctx.fillStyle = (x + y) % 3 ? "#73978b" : "#203b48";
      ctx.fillRect(x, y, 4, 5);
    }
  const tex = new T.CanvasTexture(canvas);
  tex.colorSpace = T.SRGBColorSpace;
  const material = new T.MeshStandardMaterial({
    color: 0x548291,
    map: tex,
    emissiveMap: tex,
    emissive: 0xffffff,
    emissiveIntensity: 0.3,
    roughness: 0.65,
  });
  const city = new T.InstancedMesh(new T.BoxGeometry(1, 1, 1), material, count);
  const dummy = new T.Object3D();
  for (let i = 0; i < count; i++) {
    const a = i * 2.399963,
      r = 48 + Math.sqrt(i / count) * 170,
      // Instance 3 sits on the default-view ray to the PV carport. Keep a low annex,
      // preserving its campus index/colour contract while opening the foreground.
      h = i === 3 ? 3 : 5 + ((i * 17) % 29);
    dummy.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
    dummy.scale.set(7 + (i % 6), h, 6 + (i % 5));
    dummy.rotation.y = i * 0.7;
    dummy.updateMatrix();
    city.setMatrixAt(i, dummy.matrix);
    city.setColorAt(i, new T.Color(0x4c6c78));
  }
  city.castShadow = true;
  group.add(city);
  const trees = new T.InstancedMesh(
    new T.ConeGeometry(1, 4, 7),
    new T.MeshStandardMaterial({ color: 0x245b48 }),
    72,
  );
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    dummy.position.set(Math.cos(a) * 29, 2, Math.sin(a) * 29);
    dummy.scale.setScalar(1);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    trees.setMatrixAt(i, dummy.matrix);
  }
  group.add(trees);
  for (const x of [-37, 37]) {
    const road = new T.Mesh(
      new T.BoxGeometry(8, 0.05, 400),
      new T.MeshStandardMaterial({ color: 0x0b131a }),
    );
    road.position.set(x, 0.05, 0);
    group.add(road);
  }
  const lanes = new T.InstancedMesh(
    new T.BoxGeometry(0.12, 0.04, 2.5),
    new T.MeshBasicMaterial({ color: 0x54bbc3 }),
    80,
  );
  for (let i = 0; i < 80; i++) {
    dummy.position.set(i < 40 ? -37 : 37, 0.12, (i % 40) * 10 - 200);
    dummy.updateMatrix();
    lanes.setMatrixAt(i, dummy.matrix);
  }
  group.add(lanes);
  const traffic = new T.Points(
    new T.BufferGeometry().setAttribute(
      "position",
      new T.Float32BufferAttribute(
        Array.from({ length: 24 }, (_, i) => [
          i < 12 ? -35 : 35,
          0.25,
          (i % 12) * 30 - 180,
        ]).flat(),
        3,
      ),
    ),
    new T.PointsMaterial({ color: 0x82e9ff, size: 0.8 }),
  );
  group.add(traffic);
  const sky = new T.Mesh(
    new T.SphereGeometry(850, 24, 12),
    new T.ShaderMaterial({
      side: T.BackSide,
      uniforms: {
        top: { value: new T.Color(0x030914) },
        bottom: { value: new T.Color(0x102331) },
      },
      vertexShader:
        "varying float h;void main(){h=normalize(position).y;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
      fragmentShader:
        "uniform vec3 top;uniform vec3 bottom;varying float h;void main(){gl_FragColor=vec4(mix(bottom,top,smoothstep(-.05,.7,h)),1.);}",
    }),
  );
  group.add(sky);
  return { group, city, material, sky, traffic };
}
