import * as THREE from 'three';
import { records } from './data';

/** One atlas and one batch for every visible cassette, including repeated rows. */
export class AlbumCovers {
  private canvas = document.createElement('canvas');
  private texture: THREE.CanvasTexture;
  private revision = 0;
  private selected = 0;
  private images = new Map<string, Promise<HTMLImageElement>>();
  private geometries: THREE.PlaneGeometry[];
  private tiles: THREE.InstancedBufferAttribute;
  private capacity = 512;
  array: THREE.InstancedMesh;
  face: THREE.Mesh;

  constructor(private scene: THREE.Scene, signal: AbortSignal) {
    this.canvas.width = 2048; this.canvas.height = 1280;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const geometry = new THREE.PlaneGeometry(4.7, 3.35).translate(0, 1.85, .267);
    this.geometries = records.map((_, index) => {
      const g = geometry.clone(), uv = g.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (index % 8 + .012 + uv.getX(i) * .976) / 8, (4 - Math.floor(index / 8) + .012 + uv.getY(i) * .976) / 5);
      return g;
    });
    const material = new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false, side: THREE.DoubleSide });
    this.face = new THREE.Mesh(this.geometries[0], material);
    this.face.name = 'song-cover-face';
    this.face.userData.albumCover = true;
    const arrayMaterial = material.clone();
    arrayMaterial.onBeforeCompile = shader => {
      shader.vertexShader = 'attribute float albumTile;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv = (vec2(mod(albumTile, 8.0), 4.0 - floor(albumTile / 8.0)) + vec2(.012) + vMapUv * .976) / vec2(8.0, 5.0);');
    };
    arrayMaterial.customProgramCacheKey = () => 'rhine-song-cover-atlas-v1';
    this.tiles = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('albumTile', this.tiles);
    this.array = new THREE.InstancedMesh(geometry, arrayMaterial, this.capacity);
    this.array.name = 'song-cover-array';
    this.array.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.array.frustumCulled = false;
    this.array.count = 0;
    scene.add(this.array);
    window.addEventListener('rhine-covers-changed', () => { void this.refresh(); }, { signal });
    void this.refresh();
  }

  select(index: number) { this.selected = index; this.face.geometry = this.geometries[index]; }
  setInstance(index: number, matrix: THREE.Matrix4, track: number) {
    if (index >= this.capacity) {
      this.capacity *= 2;
      const previous = this.array;
      this.tiles = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1).setUsage(THREE.DynamicDrawUsage);
      this.tiles.array.set(previous.geometry.getAttribute('albumTile').array);
      previous.geometry.setAttribute('albumTile', this.tiles);
      this.array = new THREE.InstancedMesh(previous.geometry, previous.material, this.capacity);
      this.array.instanceMatrix.array.set(previous.instanceMatrix.array);
      this.array.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.array.frustumCulled = false;
      this.scene.remove(previous); previous.dispose(); this.scene.add(this.array);
    }
    this.array.setMatrixAt(index, matrix); this.tiles.setX(index, track);
  }
  finish(count: number) { this.array.count = count; this.array.instanceMatrix.needsUpdate = true; this.tiles.needsUpdate = true; }

  private async refresh() {
    const revision = ++this.revision, c = this.canvas.getContext('2d')!;
    const groups = new Map<string, number[]>();
    records.forEach((record, index) => {
      const x = index % 8 * 256, y = Math.floor(index / 8) * 256;
      c.save(); c.translate(x,y);c.scale(256/192,256/192);c.translate(-x,-y);
      c.fillStyle = '#e4dfd3'; c.fillRect(x, y, 192, 192);
      c.fillStyle = '#c29b55'; c.fillRect(x + 12, y + 12, 168, 5);
      c.fillStyle = '#383b36'; c.font = 'bold 14px sans-serif';
      c.fillText('AUDIO ARCHIVE', x + 12, y + 43, 165);
      c.font = 'bold 20px sans-serif'; c.fillText(record.title.slice(0, 12), x + 12, y + 90, 165);
      c.font = '12px sans-serif'; c.fillText(record.department.slice(0, 18), x + 12, y + 120, 165);
      c.fillText(record.date, x + 12, y + 166, 165);
      c.restore();
      if (record.cover) groups.set(record.cover, [...(groups.get(record.cover) ?? []), index]);
    });
    this.texture.needsUpdate = true; this.select(this.selected);
    const pending = [...groups.entries()];
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (pending.length && revision === this.revision) {
        const [url, indices] = pending.shift()!;
        try {
          let loading=this.images.get(url);
          if(!loading){loading=(async()=>{for(let attempt=0;attempt<2;attempt++){try{const img=new Image();img.decoding='async';img.src=url;await img.decode();return img;}catch(e){if(attempt)throw e;await new Promise(r=>setTimeout(r,350));}}throw Error('封面无法读取');})();this.images.set(url,loading);void loading.catch(()=>this.images.delete(url));if(this.images.size>80)this.images.delete(this.images.keys().next().value!);}
          const img = await loading;
          if (revision !== this.revision) return;
          const aspect=4.7/3.35,w=Math.min(img.naturalWidth,img.naturalHeight*aspect),h=w/aspect;
          for (const index of indices) c.drawImage(img, (img.naturalWidth - w) / 2, (img.naturalHeight - h) / 2, w, h, index % 8 * 256, Math.floor(index / 8) * 256, 256, 256);
          this.texture.needsUpdate = true;
        } catch { /* Keep the song's own title when its provider has no artwork. */ }
      }
    }));
  }
  dispose() { this.revision++;this.images.clear(); this.geometries.forEach(g => g.dispose()); this.texture.dispose(); }
}
