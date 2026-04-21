/*
 * Ballistic Gas Fluid Simulator – Core Engine
 * Based on Pavel Dobryakov's WebGL Fluid Simulation (MIT License)
 * https://github.com/PavelDoGreat/WebGL-Fluid-Simulation
 *
 * Modifications:
 *  - Removed promo/GUI/analytics
 *  - Added uObstacle texture support in 4 shaders
 *  - Added obstacle overlay render pass
 *  - Exposed API via window.FluidSim
 */

'use strict';

(function () {

// ─── Public API surface (populated after init) ───────────────────────────────
window.FluidSim = {
    OBSTACLE_RES: 256,
    init,
    splat:                   null,
    uploadObstacleTexture:   null,
    setConfig:               null,
    getConfig:               null,
    setBeforeStepCallback:   null,
};

// ─── Init ─────────────────────────────────────────────────────────────────────
function init(canvas) {

let config = {
    SIM_RESOLUTION:       384,
    DYE_RESOLUTION:       1440,
    DENSITY_DISSIPATION:  1,
    VELOCITY_DISSIPATION: 0.2,
    PRESSURE:             0.8,
    PRESSURE_ITERATIONS:  20,
    CURL:                 30,
    SPLAT_RADIUS:         0.25,
    SPLAT_FORCE:          6000,
    SHADING:              true,
    COLORFUL:             true,
    COLOR_UPDATE_SPEED:   10,
    PAUSED:               false,
    BACK_COLOR:           { r: 0, g: 0, b: 0 },
    TRANSPARENT:          false,
    BLOOM:                true,
    BLOOM_ITERATIONS:     8,
    BLOOM_RESOLUTION:     384,
    BLOOM_INTENSITY:      0.8,
    BLOOM_THRESHOLD:      0.6,
    BLOOM_SOFT_KNEE:      0.7,
    SUNRAYS:              true,
    SUNRAYS_RESOLUTION:   196,
    SUNRAYS_WEIGHT:       1.0,
};

let _beforeStepCallback = null;

// ─── WebGL context ────────────────────────────────────────────────────────────
const { gl, ext, isWebGL2 } = getWebGLContext(canvas);

if (isMobile()) { config.SIM_RESOLUTION = 256; config.DYE_RESOLUTION = 1024; }
if (!ext.supportLinearFiltering) {
    config.DYE_RESOLUTION = 1024;
    config.SHADING = false;
    config.BLOOM = false;
    config.SUNRAYS = false;
}

function getWebGLContext(canvas) {
    const params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: true };
    let gl = canvas.getContext('webgl2', params);
    const isWebGL2 = !!gl;
    if (!isWebGL2) gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);

    let halfFloat, supportLinearFiltering;
    if (isWebGL2) {
        gl.getExtension('EXT_color_buffer_float');
        supportLinearFiltering = gl.getExtension('OES_texture_float_linear');
    } else {
        halfFloat = gl.getExtension('OES_texture_half_float');
        supportLinearFiltering = gl.getExtension('OES_texture_half_float_linear');
    }

    gl.clearColor(0, 0, 0, 1);

    const halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : halfFloat.HALF_FLOAT_OES;
    let formatRGBA, formatRG, formatR;
    if (isWebGL2) {
        formatRGBA = getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType);
        formatRG   = getSupportedFormat(gl, gl.RG16F,   gl.RG,   halfFloatTexType);
        formatR    = getSupportedFormat(gl, gl.R16F,    gl.RED,  halfFloatTexType);
    } else {
        formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
        formatRG   = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
        formatR    = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
    }
    return { gl, ext: { formatRGBA, formatRG, formatR, halfFloatTexType, supportLinearFiltering }, isWebGL2 };
}

function getSupportedFormat(gl, internalFormat, format, type) {
    if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
        switch (internalFormat) {
            case gl.R16F:   return getSupportedFormat(gl, gl.RG16F,   gl.RG,   type);
            case gl.RG16F:  return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
            default:        return null;
        }
    }
    return { internalFormat, format };
}

function supportRenderTextureFormat(gl, internalFormat, format, type) {
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
    let fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
}

// ─── Shader compilation ───────────────────────────────────────────────────────
class Material {
    constructor(vertexShader, fragmentShaderSource) {
        this.vertexShader = vertexShader;
        this.fragmentShaderSource = fragmentShaderSource;
        this.programs = [];
        this.activeProgram = null;
        this.uniforms = [];
    }
    setKeywords(keywords) {
        let hash = 0;
        for (let i = 0; i < keywords.length; i++) hash += hashCode(keywords[i]);
        let program = this.programs[hash];
        if (program == null) {
            let fragmentShader = compileShader(gl.FRAGMENT_SHADER, this.fragmentShaderSource, keywords);
            program = createProgram(this.vertexShader, fragmentShader);
            this.programs[hash] = program;
        }
        if (program === this.activeProgram) return;
        this.uniforms = getUniforms(program);
        this.activeProgram = program;
    }
    bind() { gl.useProgram(this.activeProgram); }
}

class Program {
    constructor(vertexShader, fragmentShader) {
        this.uniforms = {};
        this.program = createProgram(vertexShader, fragmentShader);
        this.uniforms = getUniforms(this.program);
    }
    bind() { gl.useProgram(this.program); }
}

function createProgram(vertexShader, fragmentShader) {
    let program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        console.error(gl.getProgramInfoLog(program));
    return program;
}

function getUniforms(program) {
    let uniforms = [];
    let count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
        let name = gl.getActiveUniform(program, i).name;
        uniforms[name] = gl.getUniformLocation(program, name);
    }
    return uniforms;
}

function compileShader(type, source, keywords) {
    source = addKeywords(source, keywords);
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        console.error(gl.getShaderInfoLog(shader));
    return shader;
}

function addKeywords(source, keywords) {
    if (keywords == null) return source;
    let s = '';
    keywords.forEach(k => { s += '#define ' + k + '\n'; });
    return s + source;
}

// ─── Vertex shaders ───────────────────────────────────────────────────────────
const baseVertexShader = compileShader(gl.VERTEX_SHADER, `
    precision highp float;
    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform vec2 texelSize;
    void main () {
        vUv = aPosition * 0.5 + 0.5;
        vL = vUv - vec2(texelSize.x, 0.0);
        vR = vUv + vec2(texelSize.x, 0.0);
        vT = vUv + vec2(0.0, texelSize.y);
        vB = vUv - vec2(0.0, texelSize.y);
        gl_Position = vec4(aPosition, 0.0, 1.0);
    }
`);

const blurVertexShader = compileShader(gl.VERTEX_SHADER, `
    precision highp float;
    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    uniform vec2 texelSize;
    void main () {
        vUv = aPosition * 0.5 + 0.5;
        float offset = 1.33333333;
        vL = vUv - texelSize * offset;
        vR = vUv + texelSize * offset;
        gl_Position = vec4(aPosition, 0.0, 1.0);
    }
`);

// ─── Fragment shaders ─────────────────────────────────────────────────────────
const blurShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;
    varying vec2 vUv; varying vec2 vL; varying vec2 vR;
    uniform sampler2D uTexture;
    void main () {
        vec4 sum = texture2D(uTexture, vUv) * 0.29411764;
        sum += texture2D(uTexture, vL) * 0.35294117;
        sum += texture2D(uTexture, vR) * 0.35294117;
        gl_FragColor = sum;
    }
`);

const copyShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv;
    uniform sampler2D uTexture;
    void main () { gl_FragColor = texture2D(uTexture, vUv); }
`);

const clearShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv;
    uniform sampler2D uTexture;
    uniform float value;
    void main () { gl_FragColor = value * texture2D(uTexture, vUv); }
`);

const colorShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    uniform vec4 color;
    void main () { gl_FragColor = color; }
`);

const checkerboardShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform float aspectRatio;
    #define SCALE 25.0
    void main () {
        vec2 uv = floor(vUv * SCALE * vec2(aspectRatio, 1.0));
        float v = mod(uv.x + uv.y, 2.0) * 0.1 + 0.8;
        gl_FragColor = vec4(vec3(v), 1.0);
    }
`);

// ── MODIFIED: bloom LOS guard — wall-aware post-process attenuation ──────────
//   uBloomLosGuard : 1.0 = run the line-of-sight test below. Mirrors the
//                          splat LOS guard philosophy but inverted: the splat
//                          guard ensures a wide Gaussian SOURCE doesn't write
//                          through walls; this guard ensures the multi-res
//                          bloom blur doesn't read bright dye through walls.
//                          The bloom pipeline downsamples the dye up to
//                          BLOOM_ITERATIONS halvings — at the lowest level a
//                          thin wall is sub-pixel, so bright dye on side A
//                          leaks into the blurred result sampled on side B.
//                          Fix: for each display fragment, ray-march outward
//                          in 8 directions at one obstacle texel per step,
//                          stopping each ray at the first solid cell; track
//                          the brightest dye reachable without crossing a
//                          wall. Clamp bloom ≤ reachable brightness. Gated
//                          on bloomBr > 0.01 so dim fragments don't pay the
//                          march cost (symmetric with the splat guard's
//                          gauss > 0.002 gate).
//   uObstacle      : single-channel obstacle mask (0 = fluid, 255 = solid).
//   uObstacleTexel : (1/obstacleW, 1/obstacleH) — march stride in UV.
const displayShaderSource = `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
    uniform sampler2D uTexture;
    uniform sampler2D uBloom;
    uniform sampler2D uSunrays;
    uniform sampler2D uDithering;
    uniform sampler2D uObstacle;
    uniform vec2 ditherScale;
    uniform vec2 texelSize;
    uniform vec2 uObstacleTexel;
    uniform float uBloomLosGuard;

    #define BLOOM_LOS_STEPS 8

    vec3 linearToGamma(vec3 color) {
        color = max(color, vec3(0));
        return max(1.055 * pow(color, vec3(0.416666667)) - 0.055, vec3(0));
    }

    // Ray-march outward from 'origin' in 'dir' at one obstacle-texel per step,
    // tracking the brightest dye reachable without crossing a solid cell.
    // 'target' is a saturation threshold: if we find dye this bright, we can
    // return early - the clamp (bloom *= reachable/bloomBr) wont attenuate
    // any further. Without the early exit the 8-direction * 8-step cost is
    // enough to stall display capture on some GPUs.
    float reachDye(vec2 origin, vec2 dir, float target) {
        vec2 stepV = dir * uObstacleTexel;
        vec2 samp = origin;
        float maxBr = 0.0;
        for (int s = 0; s < BLOOM_LOS_STEPS; s++) {
            samp += stepV;
            if (texture2D(uObstacle, samp).x > 0.5) break;
            vec3 d = texture2D(uTexture, samp).rgb;
            maxBr = max(maxBr, max(d.r, max(d.g, d.b)));
            if (maxBr >= target) break;
        }
        return maxBr;
    }

    void main () {
        vec3 c = texture2D(uTexture, vUv).rgb;
    #ifdef SHADING
        vec3 lc = texture2D(uTexture, vL).rgb;
        vec3 rc = texture2D(uTexture, vR).rgb;
        vec3 tc = texture2D(uTexture, vT).rgb;
        vec3 bc = texture2D(uTexture, vB).rgb;
        float dx = length(rc) - length(lc);
        float dy = length(tc) - length(bc);
        vec3 n = normalize(vec3(dx, dy, length(texelSize)));
        float diffuse = clamp(dot(n, vec3(0,0,1)) + 0.7, 0.7, 1.0);
        c *= diffuse;
    #endif
    #ifdef BLOOM
        vec3 bloom = texture2D(uBloom, vUv).rgb;
        if (uBloomLosGuard > 0.5) {
            if (texture2D(uObstacle, vUv).x > 0.5) {
                bloom = vec3(0.0);
            } else {
                float bloomBr = max(bloom.r, max(bloom.g, bloom.b));
                if (bloomBr > 0.01) {
                    vec3 selfC = texture2D(uTexture, vUv).rgb;
                    float reachableBr = max(selfC.r, max(selfC.g, selfC.b));
                    const float I = 0.70710678;
                    if (reachableBr < bloomBr) reachableBr = max(reachableBr, reachDye(vUv, vec2( 1.0,  0.0), bloomBr));
                    if (reachableBr < bloomBr) reachableBr = max(reachableBr, reachDye(vUv, vec2(-1.0,  0.0), bloomBr));
                    if (reachableBr < bloomBr) reachableBr = max(reachableBr, reachDye(vUv, vec2( 0.0,  1.0), bloomBr));
                    if (reachableBr < bloomBr) reachableBr = max(reachableBr, reachDye(vUv, vec2( 0.0, -1.0), bloomBr));
                    if (reachableBr < bloomBr) reachableBr = max(reachableBr, reachDye(vUv, vec2(  I,   I), bloomBr));
                    if (reachableBr < bloomBr) reachableBr = max(reachableBr, reachDye(vUv, vec2( -I,   I), bloomBr));
                    if (reachableBr < bloomBr) reachableBr = max(reachableBr, reachDye(vUv, vec2(  I,  -I), bloomBr));
                    if (reachableBr < bloomBr) reachableBr = max(reachableBr, reachDye(vUv, vec2( -I,  -I), bloomBr));
                    if (bloomBr > reachableBr + 1e-4) {
                        bloom *= reachableBr / bloomBr;
                    }
                }
            }
        }
    #endif
    #ifdef SUNRAYS
        float sunrays = texture2D(uSunrays, vUv).r;
        c *= sunrays;
        #ifdef BLOOM
        bloom *= sunrays;
        #endif
    #endif
    #ifdef BLOOM
        float noise = texture2D(uDithering, vUv * ditherScale).r;
        noise = noise * 2.0 - 1.0;
        bloom += noise / 255.0;
        bloom = linearToGamma(bloom);
        c += bloom;
    #endif
        float a = max(c.r, max(c.g, c.b));
        gl_FragColor = vec4(c, a);
    }
`;

const bloomPrefilterShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float; precision mediump sampler2D;
    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform vec3 curve;
    uniform float threshold;
    void main () {
        vec3 c = texture2D(uTexture, vUv).rgb;
        float br = max(c.r, max(c.g, c.b));
        float rq = clamp(br - curve.x, 0.0, curve.y);
        rq = curve.z * rq * rq;
        c *= max(rq, br - threshold) / max(br, 0.0001);
        gl_FragColor = vec4(c, 0.0);
    }
`);

const bloomBlurShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float; precision mediump sampler2D;
    varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
    uniform sampler2D uTexture;
    void main () {
        vec4 sum = (texture2D(uTexture,vL)+texture2D(uTexture,vR)+texture2D(uTexture,vT)+texture2D(uTexture,vB))*0.25;
        gl_FragColor = sum;
    }
`);

const bloomFinalShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float; precision mediump sampler2D;
    varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
    uniform sampler2D uTexture;
    uniform float intensity;
    void main () {
        vec4 sum = (texture2D(uTexture,vL)+texture2D(uTexture,vR)+texture2D(uTexture,vT)+texture2D(uTexture,vB))*0.25;
        gl_FragColor = sum * intensity;
    }
`);

const sunraysMaskShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uTexture;
    void main () {
        vec4 c = texture2D(uTexture, vUv);
        float br = max(c.r, max(c.g, c.b));
        c.a = 1.0 - min(max(br * 20.0, 0.0), 0.8);
        gl_FragColor = c;
    }
`);

const sunraysShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform float weight;
    #define ITERATIONS 16
    void main () {
        float Density = 0.3, Decay = 0.95, Exposure = 0.7;
        vec2 coord = vUv;
        vec2 dir = (vUv - 0.5) / float(ITERATIONS) * Density;
        float illuminationDecay = 1.0;
        float color = texture2D(uTexture, vUv).a;
        for (int i = 0; i < ITERATIONS; i++) {
            coord -= dir;
            color += texture2D(uTexture, coord).a * illuminationDecay * weight;
            illuminationDecay *= Decay;
        }
        gl_FragColor = vec4(color * Exposure, 0.0, 0.0, 1.0);
    }
`);

// ── MODIFIED: obstacle-aware splat — flag splatGuard toggles ──────────────────
//   uSplatGuard     : 1.0 = skip writing into cells that are themselves solid
//   uSplatLosGuard  : 1.0 = line-of-sight test. Ray-march from splat center
//                            to the fragment; if any obstacle cell is crossed,
//                            the Gaussian's contribution is zeroed for this
//                            fragment. Without this, a wide Gaussian writes
//                            dye/velocity directly through thin walls — the
//                            source of the "exit blast leaks past objects
//                            near the muzzle" bug. Only runs inside the
//                            Gaussian's effective footprint (gauss > 0.002)
//                            so far-away fragments don't pay the march cost.
//   uObstacleTexel  : (1/obstacleW, 1/obstacleH) — used for march step sizing.
const splatShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uTarget;
    uniform sampler2D uObstacle;
    uniform float aspectRatio;
    uniform vec3 color;
    uniform vec2 point;
    uniform float radius;
    uniform float uSplatGuard;
    uniform float uSplatLosGuard;
    uniform vec2  uObstacleTexel;

    #define SPLAT_LOS_MAX_STEPS 64

    void main () {
        vec3 base = texture2D(uTarget, vUv).xyz;
        if (uSplatGuard > 0.5 && texture2D(uObstacle, vUv).x > 0.5) { gl_FragColor = vec4(base, 1.0); return; }
        vec2 p = vUv - point.xy;
        p.x *= aspectRatio;
        float gauss = exp(-dot(p,p)/radius);
        if (uSplatLosGuard > 0.5 && gauss > 0.002) {
            vec2 delta = vUv - point.xy;
            float lenTexelsMax = max(abs(delta.x) / uObstacleTexel.x,
                                     abs(delta.y) / uObstacleTexel.y);
            float fsteps = clamp(ceil(lenTexelsMax * 2.0) + 1.0, 4.0, float(SPLAT_LOS_MAX_STEPS));
            vec2 stepUv = delta / fsteps;
            vec2 samp = point.xy;
            int steps = int(fsteps);
            for (int i = 0; i < SPLAT_LOS_MAX_STEPS; i++) {
                if (i >= steps - 1) break;
                samp += stepUv;
                if (texture2D(uObstacle, samp).x > 0.5) { gl_FragColor = vec4(base, 1.0); return; }
            }
        }
        vec3 splat = gauss * color;
        gl_FragColor = vec4(base + splat, 1.0);
    }
`);

// ── MODIFIED: obstacle-aware advection — 3 toggleable obstacle behaviours ─────
//   uAdvSolidZero       : 1.0 = zero dye/vel inside solid cells
//   uAdvWakeFill        : 1.0 = 8-neighbor fill for cells just freed by moving obstacles
//   uAdvBacktraceGuard  : 1.0 = ray-march the backtrace and stop at the first
//                                solid cell along the path (not just the endpoint).
//                                Makes the obstacle texture a true sampling
//                                boundary — thin walls block flux correctly.
const advectionShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uSource;
    uniform sampler2D uObstacle;
    uniform sampler2D uObstaclePrev;
    uniform vec2 texelSize;
    uniform vec2 dyeTexelSize;
    uniform float dt;
    uniform float dissipation;
    uniform float uAdvSolidZero;
    uniform float uAdvWakeFill;
    uniform float uAdvBacktraceGuard;

    // Max iteration count for the adaptive backtrace ray-march. Must be a
    // compile-time constant so WebGL1 accepts the loop bound. 64 steps at
    // 0.5-texel stride catches walls for backtraces up to 32 texels —
    // comfortably covers muzzle-blast flow speeds at SIM_RESOLUTION=384.
    #define ADV_BACKTRACE_MAX_STEPS 64

    vec4 bilerp(sampler2D sam, vec2 uv, vec2 tsize) {
        vec2 st = uv / tsize - 0.5;
        vec2 iuv = floor(st);
        vec2 fuv = fract(st);
        vec4 a = texture2D(sam, (iuv + vec2(0.5,0.5)) * tsize);
        vec4 b = texture2D(sam, (iuv + vec2(1.5,0.5)) * tsize);
        vec4 c = texture2D(sam, (iuv + vec2(0.5,1.5)) * tsize);
        vec4 d = texture2D(sam, (iuv + vec2(1.5,1.5)) * tsize);
        return mix(mix(a,b,fuv.x), mix(c,d,fuv.x), fuv.y);
    }

    void main () {
        if (uAdvSolidZero > 0.5 && texture2D(uObstacle, vUv).x > 0.5) { gl_FragColor = vec4(0.0); return; }

        if (uAdvWakeFill > 0.5 && texture2D(uObstaclePrev, vUv).x > 0.5) {
            vec2 ex = vec2(texelSize.x, 0.0);
            vec2 ey = vec2(0.0, texelSize.y);
            vec4 sumSrc = vec4(0.0);
            float sumW = 0.0;
            if (texture2D(uObstaclePrev, vUv - ex).x < 0.5 && texture2D(uObstacle, vUv - ex).x < 0.5) { sumSrc += texture2D(uSource, vUv - ex);         sumW += 1.0;   }
            if (texture2D(uObstaclePrev, vUv + ex).x < 0.5 && texture2D(uObstacle, vUv + ex).x < 0.5) { sumSrc += texture2D(uSource, vUv + ex);         sumW += 1.0;   }
            if (texture2D(uObstaclePrev, vUv - ey).x < 0.5 && texture2D(uObstacle, vUv - ey).x < 0.5) { sumSrc += texture2D(uSource, vUv - ey);         sumW += 1.0;   }
            if (texture2D(uObstaclePrev, vUv + ey).x < 0.5 && texture2D(uObstacle, vUv + ey).x < 0.5) { sumSrc += texture2D(uSource, vUv + ey);         sumW += 1.0;   }
            if (texture2D(uObstaclePrev, vUv - ex - ey).x < 0.5 && texture2D(uObstacle, vUv - ex - ey).x < 0.5) { sumSrc += texture2D(uSource, vUv - ex - ey) * 0.707; sumW += 0.707; }
            if (texture2D(uObstaclePrev, vUv + ex - ey).x < 0.5 && texture2D(uObstacle, vUv + ex - ey).x < 0.5) { sumSrc += texture2D(uSource, vUv + ex - ey) * 0.707; sumW += 0.707; }
            if (texture2D(uObstaclePrev, vUv - ex + ey).x < 0.5 && texture2D(uObstacle, vUv - ex + ey).x < 0.5) { sumSrc += texture2D(uSource, vUv - ex + ey) * 0.707; sumW += 0.707; }
            if (texture2D(uObstaclePrev, vUv + ex + ey).x < 0.5 && texture2D(uObstacle, vUv + ex + ey).x < 0.5) { sumSrc += texture2D(uSource, vUv + ex + ey) * 0.707; sumW += 0.707; }
            vec4 filled = sumW > 0.0 ? sumSrc / sumW : vec4(0.0);
            float decayF = 1.0 + dissipation * dt;
            gl_FragColor = filled / decayF;
            return;
        }

    #ifdef MANUAL_FILTERING
        vec2 vel = bilerp(uVelocity, vUv, texelSize).xy;
    #else
        vec2 vel = texture2D(uVelocity, vUv).xy;
    #endif
        // Ray-march the backtrace and stop at the first solid cell along
        // the PATH (not just the endpoint). Step count is ADAPTIVE:
        // steps = clamp(ceil(lengthInTexels * 2) + 1, 8, MAX), giving a
        // <= 0.5-texel stride. A fixed step count (the prior 16) silently
        // failed when the backtrace exceeded 16 texels -- step stride grew
        // past 1 texel and a 1-texel wall fit between samples, leaking
        // flux. Adaptive stride guarantees 1-texel walls always block.
        vec2 coord = vUv - dt * vel * texelSize;
        if (uAdvBacktraceGuard > 0.5) {
            vec2 totalDelta = -dt * vel * texelSize;
            float lenTexels = length(totalDelta / texelSize);
            int steps = int(clamp(ceil(lenTexels * 2.0) + 1.0,
                                  8.0,
                                  float(ADV_BACKTRACE_MAX_STEPS)));
            vec2 stepDelta = totalDelta / float(steps);
            coord = vUv;
            for (int i = 0; i < ADV_BACKTRACE_MAX_STEPS; i++) {
                if (i >= steps) break;
                vec2 next = coord + stepDelta;
                if (texture2D(uObstacle, next).x > 0.5) break;
                coord = next;
            }
        }
    #ifdef MANUAL_FILTERING
        vec4 result = bilerp(uSource, coord, dyeTexelSize);
    #else
        vec4 result = texture2D(uSource, coord);
    #endif
        float decay = 1.0 + dissipation * dt;
        gl_FragColor = result / decay;
    }`,
    ext.supportLinearFiltering ? null : ['MANUAL_FILTERING']
);

// ── MODIFIED: obstacle-aware divergence (uDivReflect toggles obstacle reflection)
const divergenceShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR;
    varying highp vec2 vT; varying highp vec2 vB;
    uniform sampler2D uVelocity;
    uniform sampler2D uObstacle;
    uniform float uDivReflect;
    void main () {
        float L = texture2D(uVelocity, vL).x;
        float R = texture2D(uVelocity, vR).x;
        float T = texture2D(uVelocity, vT).y;
        float B = texture2D(uVelocity, vB).y;
        vec2 C = texture2D(uVelocity, vUv).xy;
        if (vL.x < 0.0) { L = -C.x; }
        if (vR.x > 1.0) { R = -C.x; }
        if (vT.y > 1.0) { T = -C.y; }
        if (vB.y < 0.0) { B = -C.y; }
        if (uDivReflect > 0.5) {
            if (texture2D(uObstacle, vL).x > 0.5) { L = -C.x; }
            if (texture2D(uObstacle, vR).x > 0.5) { R = -C.x; }
            if (texture2D(uObstacle, vT).x > 0.5) { T = -C.y; }
            if (texture2D(uObstacle, vB).x > 0.5) { B = -C.y; }
        }
        gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
    }
`);

const curlShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR;
    varying highp vec2 vT; varying highp vec2 vB;
    uniform sampler2D uVelocity;
    void main () {
        float L = texture2D(uVelocity, vL).y;
        float R = texture2D(uVelocity, vR).y;
        float T = texture2D(uVelocity, vT).x;
        float B = texture2D(uVelocity, vB).x;
        gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
    }
`);

// ── MODIFIED: obstacle-aware vorticity (uVortSolidZero toggles) ───────────────
const vorticityShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
    uniform sampler2D uVelocity;
    uniform sampler2D uCurl;
    uniform sampler2D uObstacle;
    uniform float curl;
    uniform float dt;
    uniform float uVortSolidZero;
    void main () {
        if (uVortSolidZero > 0.5 && texture2D(uObstacle, vUv).x > 0.5) { gl_FragColor = vec4(0.0); return; }
        float L = texture2D(uCurl, vL).x;
        float R = texture2D(uCurl, vR).x;
        float T = texture2D(uCurl, vT).x;
        float B = texture2D(uCurl, vB).x;
        float C = texture2D(uCurl, vUv).x;
        vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
        force /= length(force) + 0.0001;
        force *= curl * C;
        force.y *= -1.0;
        vec2 velocity = texture2D(uVelocity, vUv).xy + force * dt;
        velocity = min(max(velocity, -1000.0), 1000.0);
        gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
`);

// ── MODIFIED: obstacle-aware pressure (uPressureNeumann toggles) ──────────────
const pressureShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR;
    varying highp vec2 vT; varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uDivergence;
    uniform sampler2D uObstacle;
    uniform float uPressureNeumann;
    void main () {
        float bC = texture2D(uPressure, vUv).x;
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        if (uPressureNeumann > 0.5) {
            if (texture2D(uObstacle, vL).x > 0.5) L = bC;
            if (texture2D(uObstacle, vR).x > 0.5) R = bC;
            if (texture2D(uObstacle, vT).x > 0.5) T = bC;
            if (texture2D(uObstacle, vB).x > 0.5) B = bC;
        }
        float divergence = texture2D(uDivergence, vUv).x;
        gl_FragColor = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0);
    }
`);

// ── MODIFIED: obstacle-aware gradient subtract (2 toggles) ────────────────────
//   uGradSolidZero : 1.0 = zero velocity inside solid cells
//   uGradNeumann   : 1.0 = clamp neighbor pressure to center at walls (no flux)
const gradientSubtractShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR;
    varying highp vec2 vT; varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uVelocity;
    uniform sampler2D uObstacle;
    uniform float uGradSolidZero;
    uniform float uGradNeumann;
    void main () {
        if (uGradSolidZero > 0.5 && texture2D(uObstacle, vUv).x > 0.5) { gl_FragColor = vec4(0.0); return; }
        float bC = texture2D(uPressure, vUv).x;
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        if (uGradNeumann > 0.5) {
            if (texture2D(uObstacle, vL).x > 0.5) L = bC;
            if (texture2D(uObstacle, vR).x > 0.5) R = bC;
            if (texture2D(uObstacle, vT).x > 0.5) T = bC;
            if (texture2D(uObstacle, vB).x > 0.5) B = bC;
        }
        vec2 velocity = texture2D(uVelocity, vUv).xy;
        velocity -= vec2(R - L, T - B);
        gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
`);

// ── Obstacle overlay shader (draws walls as dark gunmetal) ───────────────────
// NOTE: threshold is `< 0.9` (not `< 0.5`) so that "invisible-solid" cells
// written at value 192 (0.75) pass the physics threshold (`> 0.5`) but are
// DISCARDED by the overlay — i.e. they still block fluid but don't render.
// This is how `bulletBorderTexels` (scene.js) paints an invisible skirt
// around the bullet. Truly-visible solids (barrel / mesh / bullet) are
// written at 255 (1.0) and render normally.
const obstacleOverlayShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uObstacle;
    uniform float uOverlayAlpha; // 0 = overlay off (see-through to fluid inside solids)
    void main () {
        float solid = texture2D(uObstacle, vUv).x;
        if (solid < 0.9) discard;
        if (uOverlayAlpha < 0.01) discard;
        gl_FragColor = vec4(0.42, 0.46, 0.54, uOverlayAlpha);
    }
`);

// ─── Programs ─────────────────────────────────────────────────────────────────
const blurProgram             = new Program(blurVertexShader, blurShader);
const copyProgram             = new Program(baseVertexShader, copyShader);
const clearProgram            = new Program(baseVertexShader, clearShader);
const colorProgram            = new Program(baseVertexShader, colorShader);
const checkerboardProgram     = new Program(baseVertexShader, checkerboardShader);
const bloomPrefilterProgram   = new Program(baseVertexShader, bloomPrefilterShader);
const bloomBlurProgram        = new Program(baseVertexShader, bloomBlurShader);
const bloomFinalProgram       = new Program(baseVertexShader, bloomFinalShader);
const sunraysMaskProgram      = new Program(baseVertexShader, sunraysMaskShader);
const sunraysProgram          = new Program(baseVertexShader, sunraysShader);
const splatProgram            = new Program(baseVertexShader, splatShader);
const advectionProgram        = new Program(baseVertexShader, advectionShader);
const divergenceProgram       = new Program(baseVertexShader, divergenceShader);
const curlProgram             = new Program(baseVertexShader, curlShader);
const vorticityProgram        = new Program(baseVertexShader, vorticityShader);
const pressureProgram         = new Program(baseVertexShader, pressureShader);
const gradienSubtractProgram  = new Program(baseVertexShader, gradientSubtractShader);
const obstacleOverlayProgram  = new Program(baseVertexShader, obstacleOverlayShader);
const displayMaterial         = new Material(baseVertexShader, displayShaderSource);

// ─── Blit (full-screen quad) ─────────────────────────────────────────────────
const blit = (() => {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,-1,1,1,1,1,-1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0,1,2,0,2,3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);
    return (target, clear = false) => {
        if (target == null) {
            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        } else {
            gl.viewport(0, 0, target.width, target.height);
            gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        }
        if (clear) { gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT); }
        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    };
})();

// ─── Framebuffers ─────────────────────────────────────────────────────────────
let dye, velocity, divergence, curl, pressure, bloom, bloomFramebuffers = [], sunrays, sunraysTemp;
// Obstacle texture is ping-ponged: `obstacle` holds the current frame's map,
// `obstaclePrev` holds the previous frame's. The advection shader reads both
// so it can detect "just freed" cells (bullet moved off them) and fill them
// from neighbors instead of zero. Without this, moving obstacles leave a
// dark vacuum trail since Pavel's solver wasn't designed for them.
let obstacle       = null;
let obstaclePrev   = null;

// Obstacle-aware shader guards are permanent now (always-on). The shader
// uniforms below are still uploaded as 1.0 since the shader source reads
// them — removing the uniform plumbing would require editing the GLSL.

const ditheringTexture = createProceduralDitherTexture(128);

function initFramebuffers() {
    let simRes = getResolution(config.SIM_RESOLUTION);
    let dyeRes = getResolution(config.DYE_RESOLUTION);
    const texType  = ext.halfFloatTexType;
    const rgba     = ext.formatRGBA;
    const rg       = ext.formatRG;
    const r        = ext.formatR;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;
    gl.disable(gl.BLEND);

    if (dye == null)
        dye = createDoubleFBO(dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);
    else
        dye = resizeDoubleFBO(dye, dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);

    if (velocity == null)
        velocity = createDoubleFBO(simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);
    else
        velocity = resizeDoubleFBO(velocity, simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);

    divergence = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    curl       = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    pressure   = createDoubleFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);

    if (obstacle == null)
        obstacle = createObstacleTexture(simRes.width, simRes.height);
    if (obstaclePrev == null)
        obstaclePrev = createObstacleTexture(simRes.width, simRes.height);

    initBloomFramebuffers();
    initSunraysFramebuffers();
}

function initBloomFramebuffers() {
    let res = getResolution(config.BLOOM_RESOLUTION);
    const texType  = ext.halfFloatTexType;
    const rgba     = ext.formatRGBA;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;
    bloom = createFBO(res.width, res.height, rgba.internalFormat, rgba.format, texType, filtering);
    bloomFramebuffers.length = 0;
    for (let i = 0; i < config.BLOOM_ITERATIONS; i++) {
        let w = res.width >> (i+1), h = res.height >> (i+1);
        if (w < 2 || h < 2) break;
        bloomFramebuffers.push(createFBO(w, h, rgba.internalFormat, rgba.format, texType, filtering));
    }
}

function initSunraysFramebuffers() {
    let res = getResolution(config.SUNRAYS_RESOLUTION);
    const texType  = ext.halfFloatTexType;
    const r        = ext.formatR;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;
    sunrays     = createFBO(res.width, res.height, r.internalFormat, r.format, texType, filtering);
    sunraysTemp = createFBO(res.width, res.height, r.internalFormat, r.format, texType, filtering);
}

function createFBO(w, h, internalFormat, format, type, param) {
    gl.activeTexture(gl.TEXTURE0);
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
    let fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return {
        texture, fbo, width: w, height: h,
        texelSizeX: 1/w, texelSizeY: 1/h,
        attach(id) { gl.activeTexture(gl.TEXTURE0+id); gl.bindTexture(gl.TEXTURE_2D, texture); return id; }
    };
}

function createDoubleFBO(w, h, internalFormat, format, type, param) {
    let fbo1 = createFBO(w,h,internalFormat,format,type,param);
    let fbo2 = createFBO(w,h,internalFormat,format,type,param);
    return {
        width: w, height: h, texelSizeX: fbo1.texelSizeX, texelSizeY: fbo1.texelSizeY,
        get read() { return fbo1; }, set read(v) { fbo1 = v; },
        get write() { return fbo2; }, set write(v) { fbo2 = v; },
        swap() { let t=fbo1; fbo1=fbo2; fbo2=t; }
    };
}

function resizeFBO(target, w, h, internalFormat, format, type, param) {
    let newFBO = createFBO(w,h,internalFormat,format,type,param);
    copyProgram.bind();
    gl.uniform1i(copyProgram.uniforms.uTexture, target.attach(0));
    blit(newFBO);
    return newFBO;
}

function resizeDoubleFBO(target, w, h, internalFormat, format, type, param) {
    if (target.width === w && target.height === h) return target;
    target.read  = resizeFBO(target.read, w, h, internalFormat, format, type, param);
    target.write = createFBO(w, h, internalFormat, format, type, param);
    target.width = w; target.height = h;
    target.texelSizeX = 1/w; target.texelSizeY = 1/h;
    return target;
}

function createObstacleTexture(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // 1 byte per pixel — must set alignment to 1 or rows misalign for non-multiple-of-4 widths
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const ifmt = isWebGL2 ? gl.R8       : gl.LUMINANCE;
    const fmt  = isWebGL2 ? gl.RED      : gl.LUMINANCE;
    const zeros = new Uint8Array(w * h);
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, gl.UNSIGNED_BYTE, zeros);
    return {
        texture: tex, width: w, height: h,
        attach(id) { gl.activeTexture(gl.TEXTURE0+id); gl.bindTexture(gl.TEXTURE_2D, tex); return id; }
    };
}

function createProceduralDitherTexture(size) {
    const data = new Uint8Array(size * size);
    for (let i = 0; i < data.length; i++) data[i] = Math.floor(Math.random() * 255);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, size, size, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, data);
    return {
        texture: tex, width: size, height: size,
        attach(id) { gl.activeTexture(gl.TEXTURE0+id); gl.bindTexture(gl.TEXTURE_2D, tex); return id; }
    };
}

// ─── Keywords / display ───────────────────────────────────────────────────────
function updateKeywords() {
    let kw = [];
    if (config.SHADING) kw.push('SHADING');
    if (config.BLOOM)   kw.push('BLOOM');
    if (config.SUNRAYS) kw.push('SUNRAYS');
    displayMaterial.setKeywords(kw);
}

updateKeywords();
initFramebuffers();
// clean start – no initial splats

// ─── Main loop ────────────────────────────────────────────────────────────────
let lastUpdateTime = Date.now();
let colorUpdateTimer = 0;

function update() {
    const dt = calcDeltaTime();
    if (resizeCanvas()) initFramebuffers();
    if (_beforeStepCallback) _beforeStepCallback(dt);
    updateColors(dt);
    applyInputs();
    // Solver dt is scaled by the global time-stretch so advection AND decay
    // slow together under slow-motion. Sequencer still receives raw wall dt
    // and does its own sim-ms conversion — the two paths don't cross-mix.
    const timeStretch = (window.BALLISTIC_TIME && window.BALLISTIC_TIME.SIM_MS_PER_WALL_SEC) || 1.0;
    if (!config.PAUSED) step(dt * timeStretch);
    render(null);
    requestAnimationFrame(update);
}

function calcDeltaTime() {
    let now = Date.now();
    let dt = Math.min((now - lastUpdateTime) / 1000, 0.016666);
    lastUpdateTime = now;
    return dt;
}

function resizeCanvas() {
    let w = scaleByPixelRatio(canvas.clientWidth);
    let h = scaleByPixelRatio(canvas.clientHeight);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; return true; }
    return false;
}

function updateColors(dt) {
    colorUpdateTimer += dt * config.COLOR_UPDATE_SPEED;
    if (colorUpdateTimer >= 1) colorUpdateTimer = wrap(colorUpdateTimer, 0, 1);
}

function applyInputs() { /* mouse/touch interaction removed */ }

// ─── Simulation step ──────────────────────────────────────────────────────────
function step(dt) {
    gl.disable(gl.BLEND);

    curlProgram.bind();
    gl.uniform2f(curlProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);

    vorticityProgram.bind();
    gl.uniform2f(vorticityProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.attach(1));
    gl.uniform1i(vorticityProgram.uniforms.uObstacle, obstacle.attach(2));
    gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
    gl.uniform1f(vorticityProgram.uniforms.dt, dt);
    gl.uniform1f(vorticityProgram.uniforms.uVortSolidZero, 1.0);
    blit(velocity.write);
    velocity.swap();

    divergenceProgram.bind();
    gl.uniform2f(divergenceProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(divergenceProgram.uniforms.uObstacle, obstacle.attach(1));
    gl.uniform1f(divergenceProgram.uniforms.uDivReflect, 1.0);
    blit(divergence);

    clearProgram.bind();
    gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE);
    blit(pressure.write);
    pressure.swap();

    pressureProgram.bind();
    gl.uniform2f(pressureProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
    gl.uniform1i(pressureProgram.uniforms.uObstacle, obstacle.attach(2));
    gl.uniform1f(pressureProgram.uniforms.uPressureNeumann, 1.0);
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
        gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
        blit(pressure.write);
        pressure.swap();
    }

    gradienSubtractProgram.bind();
    gl.uniform2f(gradienSubtractProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(gradienSubtractProgram.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradienSubtractProgram.uniforms.uVelocity, velocity.read.attach(1));
    gl.uniform1i(gradienSubtractProgram.uniforms.uObstacle, obstacle.attach(2));
    gl.uniform1f(gradienSubtractProgram.uniforms.uGradSolidZero, 1.0);
    gl.uniform1f(gradienSubtractProgram.uniforms.uGradNeumann,   1.0);
    blit(velocity.write);
    velocity.swap();

    advectionProgram.bind();
    gl.uniform2f(advectionProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    if (!ext.supportLinearFiltering)
        gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    let velId = velocity.read.attach(0);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velId);
    gl.uniform1i(advectionProgram.uniforms.uSource, velId);
    gl.uniform1i(advectionProgram.uniforms.uObstacle,     obstacle.attach(1));
    gl.uniform1i(advectionProgram.uniforms.uObstaclePrev, obstaclePrev.attach(2));
    gl.uniform1f(advectionProgram.uniforms.dt, dt);
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
    gl.uniform1f(advectionProgram.uniforms.uAdvSolidZero,      1.0);
    gl.uniform1f(advectionProgram.uniforms.uAdvWakeFill,       1.0);
    gl.uniform1f(advectionProgram.uniforms.uAdvBacktraceGuard, 1.0);
    blit(velocity.write);
    velocity.swap();

    if (!ext.supportLinearFiltering)
        gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
    gl.uniform1i(advectionProgram.uniforms.uObstacle,     obstacle.attach(2));
    gl.uniform1i(advectionProgram.uniforms.uObstaclePrev, obstaclePrev.attach(3));
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
    blit(dye.write);
    dye.swap();
}

// ─── Render ───────────────────────────────────────────────────────────────────
function render(target) {
    if (config.BLOOM)   applyBloom(dye.read, bloom);
    if (config.SUNRAYS) { applySunrays(dye.read, dye.write, sunrays); blur(sunrays, sunraysTemp, 1); }

    if (target == null || !config.TRANSPARENT) {
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.BLEND);
    } else {
        gl.disable(gl.BLEND);
    }
    if (!config.TRANSPARENT) drawColor(target, normalizeColor(config.BACK_COLOR));
    if (target == null && config.TRANSPARENT) drawCheckerboard(target);
    drawDisplay(target);
    drawObstacleOverlay(target);
}

function drawColor(target, color) {
    colorProgram.bind();
    gl.uniform4f(colorProgram.uniforms.color, color.r, color.g, color.b, 1);
    blit(target);
}

function drawCheckerboard(target) {
    checkerboardProgram.bind();
    gl.uniform1f(checkerboardProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    blit(target);
}

function drawDisplay(target) {
    let width  = target == null ? gl.drawingBufferWidth  : target.width;
    let height = target == null ? gl.drawingBufferHeight : target.height;
    displayMaterial.bind();
    if (config.SHADING)
        gl.uniform2f(displayMaterial.uniforms.texelSize, 1/width, 1/height);
    gl.uniform1i(displayMaterial.uniforms.uTexture, dye.read.attach(0));
    if (config.BLOOM) {
        gl.uniform1i(displayMaterial.uniforms.uBloom, bloom.attach(1));
        gl.uniform1i(displayMaterial.uniforms.uDithering, ditheringTexture.attach(2));
        let scale = getTextureScale(ditheringTexture, width, height);
        gl.uniform2f(displayMaterial.uniforms.ditherScale, scale.x, scale.y);
        // Bloom LOS guard — ray-march against the obstacle texture to keep the
        // multi-res blur from leaking through thin walls. See display shader.
        gl.uniform1i(displayMaterial.uniforms.uObstacle, obstacle.attach(4));
        gl.uniform2f(displayMaterial.uniforms.uObstacleTexel,
                     1.0 / Math.max(1, obstacle.width),
                     1.0 / Math.max(1, obstacle.height));
        gl.uniform1f(displayMaterial.uniforms.uBloomLosGuard, bloomLosGuard ? 1.0 : 0.0);
    }
    if (config.SUNRAYS)
        gl.uniform1i(displayMaterial.uniforms.uSunrays, sunrays.attach(3));
    blit(target);
}

function drawObstacleOverlay(target) {
    if (!obstacle) return;
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);
    obstacleOverlayProgram.bind();
    gl.uniform1i(obstacleOverlayProgram.uniforms.uObstacle, obstacle.attach(0));
    gl.uniform1f(obstacleOverlayProgram.uniforms.uOverlayAlpha, 1.0);
    blit(target);
}

function applyBloom(source, destination) {
    if (bloomFramebuffers.length < 2) return;
    let last = destination;
    gl.disable(gl.BLEND);
    bloomPrefilterProgram.bind();
    let knee   = config.BLOOM_THRESHOLD * config.BLOOM_SOFT_KNEE + 0.0001;
    let curve0 = config.BLOOM_THRESHOLD - knee;
    let curve1 = knee * 2;
    let curve2 = 0.25 / knee;
    gl.uniform3f(bloomPrefilterProgram.uniforms.curve, curve0, curve1, curve2);
    gl.uniform1f(bloomPrefilterProgram.uniforms.threshold, config.BLOOM_THRESHOLD);
    gl.uniform1i(bloomPrefilterProgram.uniforms.uTexture, source.attach(0));
    blit(last);
    bloomBlurProgram.bind();
    for (let i = 0; i < bloomFramebuffers.length; i++) {
        let dest = bloomFramebuffers[i];
        gl.uniform2f(bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
        gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
        blit(dest);
        last = dest;
    }
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.BLEND);
    for (let i = bloomFramebuffers.length - 2; i >= 0; i--) {
        let baseTex = bloomFramebuffers[i];
        gl.uniform2f(bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
        gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
        gl.viewport(0, 0, baseTex.width, baseTex.height);
        blit(baseTex);
        last = baseTex;
    }
    gl.disable(gl.BLEND);
    bloomFinalProgram.bind();
    gl.uniform2f(bloomFinalProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
    gl.uniform1i(bloomFinalProgram.uniforms.uTexture, last.attach(0));
    gl.uniform1f(bloomFinalProgram.uniforms.intensity, config.BLOOM_INTENSITY);
    blit(destination);
}

function applySunrays(source, mask, destination) {
    gl.disable(gl.BLEND);
    sunraysMaskProgram.bind();
    gl.uniform1i(sunraysMaskProgram.uniforms.uTexture, source.attach(0));
    blit(mask);
    sunraysProgram.bind();
    gl.uniform1f(sunraysProgram.uniforms.weight, config.SUNRAYS_WEIGHT);
    gl.uniform1i(sunraysProgram.uniforms.uTexture, mask.attach(0));
    blit(destination);
}

function blur(target, temp, iterations) {
    blurProgram.bind();
    for (let i = 0; i < iterations; i++) {
        gl.uniform2f(blurProgram.uniforms.texelSize, target.texelSizeX, 0);
        gl.uniform1i(blurProgram.uniforms.uTexture, target.attach(0));
        blit(temp);
        gl.uniform2f(blurProgram.uniforms.texelSize, 0, target.texelSizeY);
        gl.uniform1i(blurProgram.uniforms.uTexture, temp.attach(0));
        blit(target);
    }
}

// ─── Splat ────────────────────────────────────────────────────────────────────
function multipleSplats(amount) {
    for (let i = 0; i < amount; i++) {
        const color = generateColor();
        color.r *= 10; color.g *= 10; color.b *= 10;
        splat(Math.random(), Math.random(), 1000*(Math.random()-0.5), 1000*(Math.random()-0.5), color);
    }
}

function splat(x, y, dx, dy, color, customRadius) {
    splatProgram.bind();
    gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1i(splatProgram.uniforms.uObstacle, obstacle.attach(2));
    gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(splatProgram.uniforms.point, x, y);
    gl.uniform3f(splatProgram.uniforms.color, dx, dy, 0);
    gl.uniform1f(splatProgram.uniforms.uSplatGuard, 1.0);
    gl.uniform1f(splatProgram.uniforms.uSplatLosGuard, splatLosGuard ? 1.0 : 0.0);
    gl.uniform2f(splatProgram.uniforms.uObstacleTexel,
                 1.0 / Math.max(1, obstacle.width),
                 1.0 / Math.max(1, obstacle.height));
    const r = customRadius !== undefined ? customRadius : config.SPLAT_RADIUS / 100;
    gl.uniform1f(splatProgram.uniforms.radius, correctRadius(r));
    blit(velocity.write);
    velocity.swap();

    gl.uniform1i(splatProgram.uniforms.uTarget, dye.read.attach(0));
    gl.uniform1i(splatProgram.uniforms.uObstacle, obstacle.attach(2));
    gl.uniform3f(splatProgram.uniforms.color, color.r, color.g, color.b);
    blit(dye.write);
    dye.swap();
}

// Line-of-sight splat guard — see splatShader. Toggled by debug UI; default
// on because it fixes the muzzle-blast-writes-through-thin-walls bug.
let splatLosGuard = true;

// Line-of-sight bloom guard — see display shader. Toggled by debug UI;
// default on because the multi-res bloom blur otherwise leaks glow through
// thin walls (bright dye on one side lights up fluid on the other).
let bloomLosGuard = true;

function correctRadius(radius) {
    let ar = canvas.width / canvas.height;
    if (ar > 1) radius *= ar;
    return radius;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateColor() {
    let c = HSVtoRGB(Math.random(), 1, 1);
    c.r *= 0.15; c.g *= 0.15; c.b *= 0.15;
    return c;
}

function HSVtoRGB(h, s, v) {
    let r, g, b, i = Math.floor(h*6), f = h*6-i, p = v*(1-s), q = v*(1-f*s), t = v*(1-(1-f)*s);
    switch (i%6) {
        case 0: r=v,g=t,b=p; break; case 1: r=q,g=v,b=p; break;
        case 2: r=p,g=v,b=t; break; case 3: r=p,g=q,b=v; break;
        case 4: r=t,g=p,b=v; break; case 5: r=v,g=p,b=q; break;
    }
    return { r, g, b };
}

function normalizeColor(input) { return { r: input.r/255, g: input.g/255, b: input.b/255 }; }
function wrap(v, min, max) { let r = max-min; return r===0 ? min : (v-min)%r+min; }

function getResolution(resolution) {
    let ar = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (ar < 1) ar = 1/ar;
    let min = Math.round(resolution);
    let max = Math.round(resolution * ar);
    return gl.drawingBufferWidth > gl.drawingBufferHeight
        ? { width: max, height: min }
        : { width: min, height: max };
}

function getTextureScale(texture, width, height) {
    return { x: width/texture.width, y: height/texture.height };
}

function scaleByPixelRatio(input) {
    return Math.floor(input * (window.devicePixelRatio || 1));
}

function hashCode(s) {
    let hash = 0;
    for (let i = 0; i < s.length; i++) { hash = (hash<<5)-hash+s.charCodeAt(i); hash|=0; }
    return hash;
}

function isMobile() { return /Mobi|Android/i.test(navigator.userAgent); }

// ─── Expose API ───────────────────────────────────────────────────────────────
FluidSim.splat = splat;

FluidSim.uploadObstacleTexture = function(data, w, h) {
    if (!obstacle) return;
    // Ping-pong so advection has prev+curr frame for its wake-fill pass.
    const tmp    = obstaclePrev;
    obstaclePrev = obstacle;
    obstacle     = tmp;

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const ifmt = isWebGL2 ? gl.R8  : gl.LUMINANCE;
    const fmt  = isWebGL2 ? gl.RED : gl.LUMINANCE;

    gl.bindTexture(gl.TEXTURE_2D, obstacle.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, gl.UNSIGNED_BYTE, data);
    obstacle.width = w;
    obstacle.height = h;
};

FluidSim.setConfig = function(key, val) {
    if (key in config) {
        config[key] = val;
        if (key === 'SHADING' || key === 'BLOOM' || key === 'SUNRAYS') updateKeywords();
    }
};

FluidSim.getConfig   = () => config;
FluidSim.setBeforeStepCallback = fn => { _beforeStepCallback = fn; };
FluidSim.setSplatLosGuard = v => { splatLosGuard = !!v; };
FluidSim.setBloomLosGuard = v => { bloomLosGuard = !!v; };

FluidSim.getSimSize = function() {
    return getResolution(config.SIM_RESOLUTION);
};

// Start the loop
update();

} // end init()

})();
