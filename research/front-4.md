# Front 4 — Blender 3.4 3D (headless, Cycles CPU)

Tested on: Blender 3.4.1 Linux x64 (hash 55485cb379f7), `blender -b --factory-startup --python-exit-code 1 --python x.py`, in a container with no GPU or display, 2026-11-08. `tested` = ran there and exited 0 with the stated output. Docs: https://docs.blender.org/manual/en/3.4/ and https://docs.blender.org/api/3.4/

## Answer
Headless 3.4 means Cycles on CPU. Use 16–64 samples, adaptive sampling, and OIDN denoising with albedo and normal passes, plus Filmic. AgX is absent in 3.4. Eevee aborts with no display, so Shader to RGB toon shading is unusable headless. In Cycles it returns a flat value (tested). For anime/toon work, use Freestyle and inverted-hull outlines in Cycles; both render headless (tested). For realism, use real-metre scale with applied scale, bevels, noise-driven roughness and bump, an HDRI world, and DOF on the camera.

## Core rules
- Always pass `-b --factory-startup --python-exit-code 1`. Without the exit-code flag, a Python exception still exits 0. https://docs.blender.org/manual/en/3.4/advanced/command_line/arguments.html
- Set `scene.cycles.device='CPU'` and do not use Eevee headless. Eevee needs an OpenGL context: it aborted (rc −6, GHOST error) in the test. https://docs.blender.org/manual/en/3.4/render/eevee/introduction.html
- Use `samples` 16–64, `use_adaptive_sampling=True` and `denoiser='OPENIMAGEDENOISE'` with `denoising_input_passes='RGB_ALBEDO_NORMAL'`. OIDN runs on CPU, while OptiX needs an NVIDIA GPU. https://docs.blender.org/manual/en/3.4/render/cycles/render_settings/sampling.html
- Use `view_transform='Filmic'` for realism and `'Standard'` for flat toon colours. 3.4 offers only Standard/Filmic/Filmic Log/Raw/False Color, and AgX came in 4.0 (tested: setting AgX raises TypeError). https://docs.blender.org/manual/en/3.4/render/color_management.html
- Model in metres at true size and apply scale (`transform_apply(scale=True)`). Bevel width, DOF and light falloff all assume real units and unit scale. https://docs.blender.org/manual/en/3.4/scene_layout/scene/properties.html#units
- Bevel every hard edge with Bevel modifier, `limit_method='ANGLE'`, 2–3 segments and ~1–2 mm width. Real edges catch highlights. https://docs.blender.org/manual/en/3.4/modeling/modifiers/generate/bevel.html
- Turn on `mesh.use_auto_smooth` before using `harden_normals`. 3.4 needs it, and auto smooth was removed in 4.1, so do not port this blindly. https://docs.blender.org/manual/en/3.4/modeling/meshes/structure.html#auto-smooth
- Keep quads and even edge loops for anything you subdivide. Triangles and n-gons pinch under Subdivision Surface. https://docs.blender.org/manual/en/3.4/modeling/modifiers/generate/subdivision_surface.html
- Unwrap before using image textures. `bpy.ops.uv.smart_project` works headless in Edit Mode on the active object (tested). https://docs.blender.org/manual/en/3.4/modeling/meshes/editing/uv.html
- Set colour images to sRGB and roughness, metallic and normal maps to `Non-Color`. Wrong colour space breaks PBR response. https://docs.blender.org/manual/en/3.4/render/shader_nodes/textures/image.html
- Break up perfect surfaces: drive roughness with Noise → ColorRamp and add a weak Bump (0.02–0.1). Uniform roughness looks CG. https://docs.blender.org/manual/en/3.4/render/shader_nodes/shader/principled.html
- Light realism with an HDRI (Environment Texture → Background) and rotate it with a Mapping node. It gives you both reflections and ambient light. https://docs.blender.org/manual/en/3.4/render/shader_nodes/textures/environment.html
- Use DOF via `cam.data.dof` (focus_object plus f-stop 1.4–4) and an 50–85 mm lens for product shots. DOF only reads correctly at true scale. https://docs.blender.org/manual/en/3.4/render/cameras.html
- Treat Shader to RGB as Eevee-only. It does nothing in Cycles: the tested Cycles render gave a flat 0.81 grey with no light banding. https://docs.blender.org/manual/en/3.4/render/shader_nodes/converter/shader_to_rgb.html
- Headless toon = constant-interpolation ColorRamp, inverted-hull outline, and/or Freestyle, all under Cycles. These are the toon paths that render without a GPU context. https://docs.blender.org/manual/en/3.4/render/freestyle/index.html

## Reference

### Render settings, Cycles CPU, low samples + denoise — tested (exit 0, 128×96, 32 samples in 0.08 s, PNG saved)
```python
import bpy
sc=bpy.context.scene
sc.render.engine='CYCLES'; sc.cycles.device='CPU'
sc.cycles.samples=32
sc.cycles.use_adaptive_sampling=True; sc.cycles.adaptive_threshold=0.05
sc.cycles.use_denoising=True
sc.cycles.denoiser='OPENIMAGEDENOISE'
sc.cycles.denoising_input_passes='RGB_ALBEDO_NORMAL'
sc.cycles.max_bounces=4
sc.render.resolution_x,sc.render.resolution_y=1280,960
sc.view_settings.view_transform='Filmic'; sc.view_settings.look='Medium High Contrast'
sc.render.image_settings.file_format='PNG'; sc.render.filepath='//out.png'
bpy.ops.render.render(write_still=True)
```
API: https://docs.blender.org/api/3.4/bpy.types.CyclesRenderSettings.html (the Cycles addon properties come from `scene.cycles`).

### AgX check — tested
`vs.view_transform='AgX'` → `TypeError: enum "AgX" not found in ('Standard','Filmic','Filmic Log','Raw','False Color')`.

### Topology: true scale, applied scale, bevel, smoothing — tested (exit 0, dims 0.4×0.3×0.02 m, 96 evaluated verts)
```python
import bpy
bpy.ops.mesh.primitive_cube_add(size=1)
o=bpy.context.active_object
o.scale=(0.4,0.3,0.02)                      # metres
bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
o.data.use_auto_smooth=True; o.data.auto_smooth_angle=0.5236   # 30°
bpy.ops.object.shade_smooth()
b=o.modifiers.new("Bevel","BEVEL"); b.width=0.002; b.segments=3
b.limit_method='ANGLE'; b.harden_normals=True
s=o.modifiers.new("Sub","SUBSURF"); s.levels=1; s.render_levels=2   # only on quad topology
```
Observed: the log still printed `Bevel: Enable 'Auto Smooth'` once, even with auto smooth set first. The evaluated mesh was fine. Treat that log line as noise only if `use_auto_smooth` is True. https://docs.blender.org/api/3.4/bpy.types.BevelModifier.html

### UVs — tested (exit 0, 1 UV layer)
```python
import bpy,math
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02)
bpy.ops.object.mode_set(mode='OBJECT')
```
https://docs.blender.org/api/3.4/bpy.ops.uv.html

### PBR + imperfection — tested (exit 0)
```python
m=bpy.data.materials.new("Metal"); m.use_nodes=True; nt=m.node_tree
p=nt.nodes["Principled BSDF"]
p.inputs["Base Color"].default_value=(0.8,0.6,0.3,1)
p.inputs["Metallic"].default_value=1.0          # 0 or 1, rarely between
p.inputs["Roughness"].default_value=0.35
n=nt.nodes.new("ShaderNodeTexNoise"); n.inputs["Scale"].default_value=40
r=nt.nodes.new("ShaderNodeValToRGB")
r.color_ramp.elements[0].position=0.4; r.color_ramp.elements[0].color=(0.25,0.25,0.25,1)
r.color_ramp.elements[1].position=0.6; r.color_ramp.elements[1].color=(0.5,0.5,0.5,1)
bm=nt.nodes.new("ShaderNodeBump"); bm.inputs["Strength"].default_value=0.05
nt.links.new(n.outputs["Fac"],r.inputs["Fac"]); nt.links.new(r.outputs["Color"],p.inputs["Roughness"])
nt.links.new(n.outputs["Fac"],bm.inputs["Height"]); nt.links.new(bm.outputs["Normal"],p.inputs["Normal"])
img.colorspace_settings.name='Non-Color'        # for roughness/metal/normal image maps
```
Input names are the 3.4 Principled v1 names. 4.0 renamed several, e.g. "Specular" → "Specular IOR Level". https://docs.blender.org/manual/en/3.4/render/shader_nodes/shader/principled.html

### HDRI world — tested (exit 0, with a generated 16×8 .hdr)
```python
w=bpy.context.scene.world; w.use_nodes=True; nt=w.node_tree
env=nt.nodes.new("ShaderNodeTexEnvironment"); env.image=bpy.data.images.load("/path/studio.hdr")
mp=nt.nodes.new("ShaderNodeMapping"); tc=nt.nodes.new("ShaderNodeTexCoord")
mp.inputs["Rotation"].default_value[2]=1.2     # radians, rotates the light
nt.links.new(tc.outputs["Generated"],mp.inputs["Vector"]); nt.links.new(mp.outputs["Vector"],env.inputs["Vector"])
nt.links.new(env.outputs["Color"],nt.nodes["Background"].inputs["Color"])
```
Free CC0 HDRIs are at https://polyhaven.com/hdris (not downloaded here; untested).

### Camera aim + DOF — tested (exit 0)
```python
cam=sc.camera; tgt=bpy.data.objects["Cube"]
cam.location=(2.5,-2.5,1.6)
cam.rotation_euler=(tgt.location-cam.location).to_track_quat('-Z','Y').to_euler()
cam.data.lens=85
cam.data.dof.use_dof=True; cam.data.dof.focus_object=tgt; cam.data.dof.aperture_fstop=2.8
```
https://docs.blender.org/api/3.4/bpy.types.CameraDOFSettings.html

### Toon: Shader to RGB + constant ramp (Eevee) — tested, FAILS headless
The graph is Diffuse → Shader to RGB → ColorRamp (`interpolation='CONSTANT'`) → Emission. When rendered with `BLENDER_EEVEE` under `-b` with no display, Blender aborted (rc −6, `GHOST/Wayland: XDG_RUNTIME_DIR is invalid`). The same graph in Cycles rendered flat (centre pixel 0.81 grey). Shader to RGB is unsupported in Cycles. Use this graph only on a machine with a GPU or display.

### Toon in Cycles without Shader to RGB — untested
Use a fixed "light" direction: Geometry.Normal → Vector Math DOT (0.5,−0.5,0.7) → ColorRamp CONSTANT → Emission. This gives two-tone banding with no lighting dependency. Pair it with `view_transform='Standard'`. https://docs.blender.org/manual/en/3.4/render/shader_nodes/converter/vector_math.html

### Inverted-hull outline — tested (exit 0, Cycles 8 samples, PNG saved)
```python
o=bpy.data.objects["Cube"]
o.data.materials.append(bpy.data.materials.new("Body"))
ol=bpy.data.materials.new("Outline"); ol.use_nodes=True; ol.use_backface_culling=True
nt=ol.node_tree; nt.nodes.remove(nt.nodes["Principled BSDF"])
e=nt.nodes.new("ShaderNodeEmission"); e.inputs["Color"].default_value=(0,0,0,1)
nt.links.new(e.outputs[0],nt.nodes["Material Output"].inputs["Surface"])
o.data.materials.append(ol)
so=o.modifiers.new("Outline","SOLIDIFY")
so.thickness=-0.02; so.use_flip_normals=True; so.use_rim=False
so.material_offset=len(o.data.materials)-1
```
Caveat: `use_backface_culling` is a viewport/Eevee setting that Cycles ignores. In Cycles the flipped shell still works as a silhouette when it is behind the body. Check the image visually; outline appearance was not inspected. https://docs.blender.org/manual/en/3.4/modeling/modifiers/generate/solidify.html

### Freestyle — tested (exit 0, Cycles, PNG saved)
```python
sc.render.use_freestyle=True
sc.render.line_thickness_mode='ABSOLUTE'; sc.render.line_thickness=1.5
vl=bpy.context.view_layer; vl.use_freestyle=True
ls=vl.freestyle_settings.linesets[0]
ls.select_by_visibility=True; ls.select_silhouette=True; ls.select_crease=True; ls.select_border=True
ls.linestyle.color=(0,0,0); ls.linestyle.thickness=2.0
vl.freestyle_settings.crease_angle=2.36       # radians (135°)
```
Freestyle is CPU post-processing and works with Cycles headless. https://docs.blender.org/api/3.4/bpy.types.FreestyleSettings.html

### Lighting (no HDRI) — untested
For a three-point setup, use Area lights with key power ~500–1000 W at 2–3 m, fill at ~⅓ of the key, and a rim light behind. Light power is physical, so wrong scale means wrong exposure. https://docs.blender.org/manual/en/3.4/render/lights/light_object.html

## Checklist
- [ ] The command has `-b --factory-startup --python-exit-code 1`, and rc is checked.
- [ ] Engine is CYCLES on CPU, and Eevee is not used headless.
- [ ] Samples ≤ 64, adaptive is on, and OIDN uses albedo and normal passes.
- [ ] View transform is Filmic for realism or Standard for toon, and there is no AgX.
- [ ] Object scale is (1,1,1) and dimensions are in real metres.
- [ ] Hard edges are bevelled, auto smooth is on in 3.4, and subdivided meshes are quads.
- [ ] Meshes using image textures have UVs, and non-colour maps are set to Non-Color.
- [ ] Roughness is varied (noise or texture), and nothing is perfectly uniform.
- [ ] The world has an HDRI or real lights, and the HDRI is rotated for a good key direction.
- [ ] The camera targets the subject, and the DOF focus object is set.
- [ ] Toon work uses no Shader to RGB in Cycles. It uses a constant ramp, outline and/or Freestyle.
- [ ] The output PNG exists and was viewed before delivery.
- [ ] Every snippet in the deliverable is tagged tested or untested.

## Disagreements and unknowns
- The harden_normals log line appeared despite auto smooth being enabled. The cause is unclear, and the output was unaffected.
- Whether Eevee works headless with EGL or a virtual display (xvfb) was not tested.
- Outline and Freestyle images were produced but not checked visually.
