# SculptGL

A 3D sculpting app that runs in the browser. Push, pull, inflate, smooth and carve a model like digital clay, then export it for 3D printing, games or other 3D tools.

**Try it in your browser, no download and no account needed:** [mytekdev.com/tools/sculptgl](https://mytekdev.com/tools/sculptgl). The page opens on a finished sculpture you can start changing straight away.

This is a fork of [SculptGL by Stéphane Ginier](https://github.com/stephomi/sculptgl), used under the MIT license. The sculpting engine is his; this version adds file formats and a rendering fix on top.

## What this version adds

- **glTF and GLB import.** Open `.gltf` and `.glb` files alongside OBJ, PLY and STL. Node transforms, scene hierarchy, multiple meshes and interleaved buffers are handled (`gltf-import.js`).
- **GLB export,** for game engines and 3D scenes, alongside OBJ, PLY and STL.
- **A depth buffer fix.** Heavy inflate strokes could open jagged holes in the mesh, because the render target used a 16-bit depth buffer. It now uses 24-bit depth with stencil.
- Sketchfab upload is not included in this build.

## Features

- Sculpting tools: Brush, Inflate, Twist, Smooth, Flatten, Pinch, Crease, Drag, Paint, Move and Masking, each with its own radius and strength
- Symmetry that mirrors every stroke
- Dynamic topology and multiresolution subdivision, for adding detail where it is needed
- Start from a sphere, cube, cylinder or torus, or import your own model
- Materials, matcaps and lighting environments
- Pressure support on drawing tablets; a mouse works too
- Runs on Chromebooks, Windows, Mac and Linux

## Run it locally

It is a static app. Serve the folder and open `index.html`:

```
python3 -m http.server 8000
```

Then visit `http://localhost:8000/index.html`.

## License

MIT. See [LICENSE](LICENSE). SculptGL is copyright Stéphane Ginier; the additions in this fork are copyright My TEK Lab, Inc.
