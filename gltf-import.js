/**
 * glTF/GLB import support for SculptGL.
 *
 * Patches the SculptGL app to add .gltf and .glb file import.
 * Converts glTF triangle meshes to binary STL format and feeds them
 * into SculptGL's existing STL import pipeline.
 *
 * Handles: node transforms, scene hierarchy, multiple meshes/primitives,
 * indexed and non-indexed geometry, interleaved buffers, byte alignment.
 *
 * Must load AFTER sculptgl.js.
 */
(function () {
  'use strict';

  // ---- glTF / GLB binary parsing ----

  function parseGLB(buffer) {
    var view = new DataView(buffer);
    if (view.getUint32(0, true) !== 0x46546C67) throw new Error('Not a valid GLB file');

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

  // Safe accessor read: handles byte alignment and interleaved buffers
  function getAccessorData(gltf, bin, accessorIndex) {
    var accessor = gltf.accessors[accessorIndex];
    if (accessor.bufferView === undefined) return null;
    var bv = gltf.bufferViews[accessor.bufferView];
    var byteOffset = (bv.byteOffset || 0) + (accessor.byteOffset || 0);
    var count = accessor.count;

    var numComp;
    switch (accessor.type) {
      case 'SCALAR': numComp = 1; break;
      case 'VEC2':   numComp = 2; break;
      case 'VEC3':   numComp = 3; break;
      case 'VEC4':   numComp = 4; break;
      case 'MAT2':   numComp = 4; break;
      case 'MAT3':   numComp = 9; break;
      case 'MAT4':   numComp = 16; break;
      default:       numComp = 1;
    }

    var componentSize;
    switch (accessor.componentType) {
      case 5126: componentSize = 4; break; // FLOAT
      case 5125: componentSize = 4; break; // UNSIGNED_INT
      case 5123: componentSize = 2; break; // UNSIGNED_SHORT
      case 5121: componentSize = 1; break; // UNSIGNED_BYTE
      case 5122: componentSize = 2; break; // SHORT
      default:   componentSize = 4;
    }

    var total = count * numComp;
    var tightStride = numComp * componentSize;
    var stride = bv.byteStride || tightStride;

    // Use DataView for safe unaligned reads (avoids TypedArray alignment errors)
    var dv = new DataView(bin, 0, bin.byteLength);

    if (accessor.componentType === 5126) {
      var out = new Float32Array(total);
      for (var i = 0; i < count; i++) {
        var rowOff = byteOffset + i * stride;
        for (var j = 0; j < numComp; j++) {
          out[i * numComp + j] = dv.getFloat32(rowOff + j * 4, true);
        }
      }
      return out;
    }
    if (accessor.componentType === 5125) {
      var out2 = new Uint32Array(total);
      for (var i2 = 0; i2 < count; i2++) {
        var rowOff2 = byteOffset + i2 * stride;
        for (var j2 = 0; j2 < numComp; j2++) {
          out2[i2 * numComp + j2] = dv.getUint32(rowOff2 + j2 * 4, true);
        }
      }
      return out2;
    }
    if (accessor.componentType === 5123) {
      var out3 = new Uint16Array(total);
      for (var i3 = 0; i3 < count; i3++) {
        var rowOff3 = byteOffset + i3 * stride;
        for (var j3 = 0; j3 < numComp; j3++) {
          out3[i3 * numComp + j3] = dv.getUint16(rowOff3 + j3 * 2, true);
        }
      }
      return out3;
    }
    if (accessor.componentType === 5121) {
      var out4 = new Uint8Array(total);
      for (var i4 = 0; i4 < count; i4++) {
        var rowOff4 = byteOffset + i4 * stride;
        for (var j4 = 0; j4 < numComp; j4++) {
          out4[i4 * numComp + j4] = dv.getUint8(rowOff4 + j4);
        }
      }
      return out4;
    }
    var out5 = new Int16Array(total);
    for (var i5 = 0; i5 < count; i5++) {
      var rowOff5 = byteOffset + i5 * stride;
      for (var j5 = 0; j5 < numComp; j5++) {
        out5[i5 * numComp + j5] = dv.getInt16(rowOff5 + j5 * 2, true);
      }
    }
    return out5;
  }

  // ---- Matrix math for node transforms ----

  function mat4Identity() {
    return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  }

  function mat4Multiply(a, b) {
    var out = new Float32Array(16);
    for (var i = 0; i < 4; i++) {
      for (var j = 0; j < 4; j++) {
        out[j * 4 + i] = a[i] * b[j * 4] + a[4 + i] * b[j * 4 + 1] +
                          a[8 + i] * b[j * 4 + 2] + a[12 + i] * b[j * 4 + 3];
      }
    }
    return out;
  }

  function mat4FromTRS(t, r, s) {
    // Build matrix from translation, rotation (quaternion), scale
    var tx = t ? t[0] : 0, ty = t ? t[1] : 0, tz = t ? t[2] : 0;
    var qx = r ? r[0] : 0, qy = r ? r[1] : 0, qz = r ? r[2] : 0, qw = r ? r[3] : 1;
    var sx = s ? s[0] : 1, sy = s ? s[1] : 1, sz = s ? s[2] : 1;

    var x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
    var xx = qx * x2, xy = qx * y2, xz = qx * z2;
    var yy = qy * y2, yz = qy * z2, zz = qz * z2;
    var wx = qw * x2, wy = qw * y2, wz = qw * z2;

    var out = new Float32Array(16);
    out[0]  = (1 - (yy + zz)) * sx;
    out[1]  = (xy + wz) * sx;
    out[2]  = (xz - wy) * sx;
    out[3]  = 0;
    out[4]  = (xy - wz) * sy;
    out[5]  = (1 - (xx + zz)) * sy;
    out[6]  = (yz + wx) * sy;
    out[7]  = 0;
    out[8]  = (xz + wy) * sz;
    out[9]  = (yz - wx) * sz;
    out[10] = (1 - (xx + yy)) * sz;
    out[11] = 0;
    out[12] = tx;
    out[13] = ty;
    out[14] = tz;
    out[15] = 1;
    return out;
  }

  function getNodeMatrix(node) {
    if (node.matrix) {
      return new Float32Array(node.matrix);
    }
    return mat4FromTRS(node.translation, node.rotation, node.scale);
  }

  function transformPoint(m, x, y, z) {
    return [
      m[0] * x + m[4] * y + m[8]  * z + m[12],
      m[1] * x + m[5] * y + m[9]  * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14]
    ];
  }

  // ---- Collect all mesh instances with world transforms ----

  function collectMeshInstances(gltf) {
    var instances = []; // [{meshIndex, worldMatrix}]

    function walkNode(nodeIndex, parentMatrix) {
      var node = gltf.nodes[nodeIndex];
      var localMatrix = getNodeMatrix(node);
      var worldMatrix = mat4Multiply(parentMatrix, localMatrix);

      if (node.mesh !== undefined) {
        instances.push({ meshIndex: node.mesh, worldMatrix: worldMatrix });
      }

      if (node.children) {
        for (var i = 0; i < node.children.length; i++) {
          walkNode(node.children[i], worldMatrix);
        }
      }
    }

    // Walk all scenes (or default scene)
    var sceneIndex = gltf.scene !== undefined ? gltf.scene : 0;
    if (gltf.scenes && gltf.scenes[sceneIndex]) {
      var roots = gltf.scenes[sceneIndex].nodes || [];
      var identity = mat4Identity();
      for (var i = 0; i < roots.length; i++) {
        walkNode(roots[i], identity);
      }
    } else if (gltf.nodes) {
      // No scene defined, walk all root nodes
      var referenced = {};
      for (var n = 0; n < gltf.nodes.length; n++) {
        if (gltf.nodes[n].children) {
          for (var c = 0; c < gltf.nodes[n].children.length; c++) {
            referenced[gltf.nodes[n].children[c]] = true;
          }
        }
      }
      var identity2 = mat4Identity();
      for (var r = 0; r < gltf.nodes.length; r++) {
        if (!referenced[r]) walkNode(r, identity2);
      }
    }

    return instances;
  }

  // ---- Build STL from glTF ----

  function gltfToSTL(gltf, bin) {
    var instances = collectMeshInstances(gltf);
    if (instances.length === 0 && gltf.meshes && gltf.meshes.length > 0) {
      // Fallback: no scene/node hierarchy, just use meshes directly
      var identity = mat4Identity();
      for (var fi = 0; fi < gltf.meshes.length; fi++) {
        instances.push({ meshIndex: fi, worldMatrix: identity });
      }
    }

    var triangles = []; // flat array of floats: 9 per triangle (3 vertices x 3 coords)

    for (var ii = 0; ii < instances.length; ii++) {
      var inst = instances[ii];
      var mesh = gltf.meshes[inst.meshIndex];
      var wm = inst.worldMatrix;

      for (var pi = 0; pi < mesh.primitives.length; pi++) {
        var prim = mesh.primitives[pi];
        // Only triangles (mode 4 or default)
        if (prim.mode !== undefined && prim.mode !== 4) continue;
        var attrs = prim.attributes;
        if (attrs.POSITION === undefined) continue;

        var pos = getAccessorData(gltf, bin, attrs.POSITION);
        if (!pos) continue;
        var nv = pos.length / 3;

        if (prim.indices !== undefined) {
          var idx = getAccessorData(gltf, bin, prim.indices);
          if (!idx) continue;
          for (var ti = 0; ti < idx.length; ti += 3) {
            var a0 = idx[ti] * 3, a1 = idx[ti + 1] * 3, a2 = idx[ti + 2] * 3;
            var p0 = transformPoint(wm, pos[a0], pos[a0 + 1], pos[a0 + 2]);
            var p1 = transformPoint(wm, pos[a1], pos[a1 + 1], pos[a1 + 2]);
            var p2 = transformPoint(wm, pos[a2], pos[a2 + 1], pos[a2 + 2]);
            triangles.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
          }
        } else {
          for (var ui = 0; ui < nv; ui += 3) {
            var b0 = ui * 3, b1 = (ui + 1) * 3, b2 = (ui + 2) * 3;
            var q0 = transformPoint(wm, pos[b0], pos[b0 + 1], pos[b0 + 2]);
            var q1 = transformPoint(wm, pos[b1], pos[b1 + 1], pos[b1 + 2]);
            var q2 = transformPoint(wm, pos[b2], pos[b2 + 1], pos[b2 + 2]);
            triangles.push(q0[0], q0[1], q0[2], q1[0], q1[1], q1[2], q2[0], q2[1], q2[2]);
          }
        }
      }
    }

    var numTris = triangles.length / 9;
    if (numTris === 0) throw new Error('No triangle geometry found in glTF file.');

    // Build binary STL: 80-byte header + 4-byte count + 50 bytes per triangle
    var bufLen = 80 + 4 + numTris * 50;
    var buf = new ArrayBuffer(bufLen);
    var view = new DataView(buf);

    view.setUint32(80, numTris, true);

    var offset = 84;
    for (var t = 0; t < numTris; t++) {
      var base = t * 9;
      var ax = triangles[base],     ay = triangles[base + 1], az = triangles[base + 2];
      var bx = triangles[base + 3], by = triangles[base + 4], bz = triangles[base + 5];
      var cx = triangles[base + 6], cy = triangles[base + 7], cz = triangles[base + 8];

      var e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      var e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      var nx = e1y * e2z - e1z * e2y;
      var ny = e1z * e2x - e1x * e2z;
      var nz = e1x * e2y - e1y * e2x;
      var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 0) { nx /= len; ny /= len; nz /= len; }

      view.setFloat32(offset, nx, true); offset += 4;
      view.setFloat32(offset, ny, true); offset += 4;
      view.setFloat32(offset, nz, true); offset += 4;
      view.setFloat32(offset, ax, true); offset += 4;
      view.setFloat32(offset, ay, true); offset += 4;
      view.setFloat32(offset, az, true); offset += 4;
      view.setFloat32(offset, bx, true); offset += 4;
      view.setFloat32(offset, by, true); offset += 4;
      view.setFloat32(offset, bz, true); offset += 4;
      view.setFloat32(offset, cx, true); offset += 4;
      view.setFloat32(offset, cy, true); offset += 4;
      view.setFloat32(offset, cz, true); offset += 4;
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

  var origGetFileType = Proto.getFileType;
  Proto.getFileType = function (name) {
    var n = name.toLowerCase();
    if (n.endsWith('.glb')) return 'glb';
    if (n.endsWith('.gltf')) return 'gltf';
    return origGetFileType.call(this, name);
  };

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

      var stlBuffer = gltfToSTL(gltf, bin);
      return origLoadScene.call(this, stlBuffer, 'stl');

    } catch (err) {
      console.error('glTF import error:', err);
      window.alert('Failed to import glTF: ' + err.message);
    }
  };

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
