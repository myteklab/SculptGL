/**
 * glTF/GLB import support for SculptGL.
 *
 * Patches the SculptGL app to add .gltf and .glb file import.
 * Converts glTF triangle meshes to binary STL format and feeds them
 * into SculptGL's existing STL import pipeline.
 *
 * Must load AFTER sculptgl.js.
 */
(function () {
  'use strict';

  // ---- glTF / GLB binary parsing ----

  function parseGLB(buffer) {
    var view = new DataView(buffer);
    var magic = view.getUint32(0, true);
    if (magic !== 0x46546C67) throw new Error('Not a valid GLB file');

    var jsonLen = view.getUint32(12, true);
    var jsonBytes = new Uint8Array(buffer, 20, jsonLen);
    var gltf = JSON.parse(new TextDecoder().decode(jsonBytes));

    var binChunkStart = 20 + jsonLen;
    var bin = null;
    if (binChunkStart + 8 <= buffer.byteLength) {
      bin = buffer.slice(binChunkStart + 8);
    }

    return { gltf: gltf, bin: bin };
  }

  function resolveBuffer(gltf) {
    if (!gltf.buffers || gltf.buffers.length === 0) return null;
    var uri = gltf.buffers[0].uri;
    if (!uri) return null;
    if (uri.startsWith('data:')) {
      var base64 = uri.split(',')[1];
      var raw = atob(base64);
      var arr = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
      return arr.buffer;
    }
    throw new Error('External buffer references not supported. Use .glb or embedded .gltf.');
  }

  function getAccessorData(gltf, bin, accessorIndex) {
    var accessor = gltf.accessors[accessorIndex];
    var bv = gltf.bufferViews[accessor.bufferView];
    var byteOffset = (bv.byteOffset || 0) + (accessor.byteOffset || 0);
    var count = accessor.count;

    var numComp;
    switch (accessor.type) {
      case 'SCALAR': numComp = 1; break;
      case 'VEC2':   numComp = 2; break;
      case 'VEC3':   numComp = 3; break;
      case 'VEC4':   numComp = 4; break;
      default:       numComp = 1;
    }

    var total = count * numComp;
    var componentSize;
    switch (accessor.componentType) {
      case 5126: componentSize = 4; break;
      case 5125: componentSize = 4; break;
      case 5123: componentSize = 2; break;
      case 5121: componentSize = 1; break;
      case 5122: componentSize = 2; break;
      default:   componentSize = 4;
    }

    // Handle interleaved buffers (byteStride)
    var stride = bv.byteStride || 0;
    var tightStride = numComp * componentSize;
    if (stride && stride !== tightStride) {
      var result = new Float32Array(total);
      for (var i = 0; i < count; i++) {
        var srcOff = byteOffset + i * stride;
        var dv = new DataView(bin, srcOff, tightStride);
        for (var j = 0; j < numComp; j++) {
          if (accessor.componentType === 5126) {
            result[i * numComp + j] = dv.getFloat32(j * 4, true);
          } else if (accessor.componentType === 5123) {
            result[i * numComp + j] = dv.getUint16(j * 2, true);
          } else if (accessor.componentType === 5121) {
            result[i * numComp + j] = dv.getUint8(j);
          }
        }
      }
      return result;
    }

    switch (accessor.componentType) {
      case 5126: return new Float32Array(bin, byteOffset, total);
      case 5125: return new Uint32Array(bin, byteOffset, total);
      case 5123: return new Uint16Array(bin, byteOffset, total);
      case 5121: return new Uint8Array(bin, byteOffset, total);
      case 5122: return new Int16Array(bin, byteOffset, total);
      default:   return new Float32Array(bin, byteOffset, total);
    }
  }

  // Extract triangles from glTF and build a binary STL buffer
  function gltfToSTL(gltf, bin) {
    // Collect all triangles
    var triangles = [];

    for (var mi = 0; mi < gltf.meshes.length; mi++) {
      var mesh = gltf.meshes[mi];

      for (var pi = 0; pi < mesh.primitives.length; pi++) {
        var prim = mesh.primitives[pi];
        if (prim.mode !== undefined && prim.mode !== 4) continue;
        var attrs = prim.attributes;
        if (attrs.POSITION === undefined) continue;

        var pos = getAccessorData(gltf, bin, attrs.POSITION);
        var nv = pos.length / 3;

        if (prim.indices !== undefined) {
          var idx = getAccessorData(gltf, bin, prim.indices);
          for (var ti = 0; ti < idx.length; ti += 3) {
            var i0 = idx[ti] * 3, i1 = idx[ti + 1] * 3, i2 = idx[ti + 2] * 3;
            triangles.push(
              pos[i0], pos[i0 + 1], pos[i0 + 2],
              pos[i1], pos[i1 + 1], pos[i1 + 2],
              pos[i2], pos[i2 + 1], pos[i2 + 2]
            );
          }
        } else {
          for (var ui = 0; ui < nv * 3; ui += 9) {
            triangles.push(
              pos[ui], pos[ui + 1], pos[ui + 2],
              pos[ui + 3], pos[ui + 4], pos[ui + 5],
              pos[ui + 6], pos[ui + 7], pos[ui + 8]
            );
          }
        }
      }
    }

    var numTris = triangles.length / 9;
    if (numTris === 0) throw new Error('No triangle geometry found in glTF file.');

    // Build binary STL: 80-byte header + 4-byte triangle count + 50 bytes per triangle
    var bufLen = 80 + 4 + numTris * 50;
    var buf = new ArrayBuffer(bufLen);
    var view = new DataView(buf);

    // Header (80 bytes, zeros)
    // Triangle count
    view.setUint32(80, numTris, true);

    var offset = 84;
    for (var t = 0; t < numTris; t++) {
      var base = t * 9;
      // Compute face normal
      var ax = triangles[base], ay = triangles[base + 1], az = triangles[base + 2];
      var bx = triangles[base + 3], by = triangles[base + 4], bz = triangles[base + 5];
      var cx = triangles[base + 6], cy = triangles[base + 7], cz = triangles[base + 8];
      var e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      var e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      var nx = e1y * e2z - e1z * e2y;
      var ny = e1z * e2x - e1x * e2z;
      var nz = e1x * e2y - e1y * e2x;
      var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 0) { nx /= len; ny /= len; nz /= len; }

      // Normal (3 floats)
      view.setFloat32(offset, nx, true); offset += 4;
      view.setFloat32(offset, ny, true); offset += 4;
      view.setFloat32(offset, nz, true); offset += 4;
      // Vertex 1
      view.setFloat32(offset, ax, true); offset += 4;
      view.setFloat32(offset, ay, true); offset += 4;
      view.setFloat32(offset, az, true); offset += 4;
      // Vertex 2
      view.setFloat32(offset, bx, true); offset += 4;
      view.setFloat32(offset, by, true); offset += 4;
      view.setFloat32(offset, bz, true); offset += 4;
      // Vertex 3
      view.setFloat32(offset, cx, true); offset += 4;
      view.setFloat32(offset, cy, true); offset += 4;
      view.setFloat32(offset, cz, true); offset += 4;
      // Attribute byte count
      view.setUint16(offset, 0, true); offset += 2;
    }

    return buf;
  }

  // ---- Patch SculptGL prototype ----

  var Proto = window.SculptGL && window.SculptGL.prototype;
  if (!Proto) {
    console.warn('gltf-import: SculptGL not found, skipping patch');
    return;
  }

  // 1. Patch getFileType to recognize .gltf/.glb
  var origGetFileType = Proto.getFileType;
  Proto.getFileType = function (name) {
    var n = name.toLowerCase();
    if (n.endsWith('.glb')) return 'glb';
    if (n.endsWith('.gltf')) return 'gltf';
    return origGetFileType.call(this, name);
  };

  // 2. Patch readFile to handle glb/gltf (both need ArrayBuffer)
  var origReadFile = Proto.readFile;
  Proto.readFile = function (file, type) {
    var self = this;
    if (type === 'glb' || type === 'gltf') {
      var r = new FileReader();
      r.onload = function (e) {
        self.loadScene(e.target.result, type);
        document.getElementById('fileopen').value = '';
      };
      r.readAsArrayBuffer(file);
    } else {
      origReadFile.call(this, file, type);
    }
  };

  // 3. Patch loadScene: convert glTF to STL, then use original STL import
  var origLoadScene = Proto.loadScene;
  Proto.loadScene = function (data, type) {
    if (type !== 'glb' && type !== 'gltf') {
      return origLoadScene.call(this, data, type);
    }

    try {
      var gltf, bin;
      if (type === 'glb') {
        var parsed = parseGLB(data);
        gltf = parsed.gltf;
        bin = parsed.bin;
      } else {
        // gltf can be text or arraybuffer
        var text = data instanceof ArrayBuffer
          ? new TextDecoder().decode(new Uint8Array(data))
          : data;
        gltf = JSON.parse(text);
        bin = resolveBuffer(gltf);
      }

      if (!gltf.meshes || gltf.meshes.length === 0) {
        window.alert('No meshes found in the glTF file.');
        return;
      }

      if (!bin) {
        window.alert('No binary buffer found. Use .glb or embedded .gltf.');
        return;
      }

      // Convert to STL and use existing import pipeline
      var stlBuffer = gltfToSTL(gltf, bin);
      return origLoadScene.call(this, stlBuffer, 'stl');

    } catch (err) {
      console.error('glTF import error:', err);
      window.alert('Failed to import glTF: ' + err.message);
    }
  };

  // 4. Update the file menu label after GUI renders
  setTimeout(function () {
    document.querySelectorAll('button, span, div').forEach(function (el) {
      if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) {
        var txt = el.textContent;
        if (txt && txt.indexOf('obj, sgl, ply, stl') !== -1) {
          el.textContent = txt.replace('obj, sgl, ply, stl', 'obj, sgl, ply, stl, glb, gltf');
        }
      }
    });
  }, 1500);

})();
