/* ============================================================
   Ink Fluid — WebGL2 stable-fluids simulation styled as
   Chinese ink (水墨) bleeding on rice paper.
   Pointer movement pushes and disperses ink which slowly fades.
   Falls back to a lightweight 2D canvas effect without WebGL2.
   ============================================================ */
(function () {
	'use strict';

	var canvas = document.getElementById('ink-canvas');
	if (!canvas) return;

	var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	if (reduceMotion) { canvas.style.display = 'none'; return; }

	var config = {
		SIM_RESOLUTION: 144,
		DYE_RESOLUTION: 720,
		DENSITY_DISSIPATION: 0.9,    // how fast ink fades (散掉)
		VELOCITY_DISSIPATION: 0.3,
		PRESSURE: 0.8,
		PRESSURE_ITERATIONS: 20,
		CURL: 12,                    // swirl / vorticity
		SPLAT_RADIUS: 0.0038,
		SPLAT_FORCE: 5200,
		INK_GAIN: 1.6
	};

	/* Ink palette — mostly blue-black sumi ink, a rare vermillion drop */
	function pickInk() {
		var r = Math.random();
		if (r < 0.06) return { r: 1.00, g: 0.22, b: 0.16 };          // 朱砂 vermillion (rare)
		if (r < 0.30) return { r: 0.55, g: 0.68, b: 1.00 };          // cool indigo ink
		var v = 0.85 + Math.random() * 0.15;
		return { r: 0.72 * v, g: 0.80 * v, b: 0.95 * v };            // sumi blue-black
	}

	var gl = canvas.getContext('webgl2', {
		alpha: true, depth: false, stencil: false,
		antialias: false, preserveDrawingBuffer: false
	});
	var floatOK = gl && gl.getExtension('EXT_color_buffer_float');

	if (!gl || !floatOK) { fallback2D(canvas); return; }

	/* ---------------- shaders ---------------- */
	var VERT = '#version 300 es\nprecision highp float;\n' +
		'in vec2 aPosition; out vec2 vUv, vL, vR, vT, vB; uniform vec2 texelSize;\n' +
		'void main(){ vUv = aPosition * 0.5 + 0.5;' +
		' vL = vUv - vec2(texelSize.x, 0.0); vR = vUv + vec2(texelSize.x, 0.0);' +
		' vT = vUv + vec2(0.0, texelSize.y); vB = vUv - vec2(0.0, texelSize.y);' +
		' gl_Position = vec4(aPosition, 0.0, 1.0); }';

	var FRAG_HEAD = '#version 300 es\nprecision highp float; precision highp sampler2D;\n' +
		'in vec2 vUv, vL, vR, vT, vB; out vec4 fragColor;\n';

	var FRAG_COPY = FRAG_HEAD + 'uniform sampler2D uTexture; void main(){ fragColor = texture(uTexture, vUv); }';

	var FRAG_CLEAR = FRAG_HEAD + 'uniform sampler2D uTexture; uniform float value;\n' +
		'void main(){ fragColor = value * texture(uTexture, vUv); }';

	var FRAG_SPLAT = FRAG_HEAD +
		'uniform sampler2D uTarget; uniform float aspectRatio; uniform vec3 color;\n' +
		'uniform vec2 point; uniform float radius;\n' +
		'void main(){ vec2 p = vUv - point; p.x *= aspectRatio;\n' +
		' vec3 splat = exp(-dot(p, p) / radius) * color;\n' +
		' fragColor = vec4(texture(uTarget, vUv).xyz + splat, 1.0); }';

	var FRAG_ADVECTION = FRAG_HEAD +
		'uniform sampler2D uVelocity, uSource; uniform vec2 texelSize;\n' +
		'uniform float dt; uniform float dissipation;\n' +
		'void main(){ vec2 coord = vUv - dt * texture(uVelocity, vUv).xy * texelSize;\n' +
		' float decay = 1.0 + dissipation * dt;\n' +
		' fragColor = texture(uSource, coord) / decay; }';

	var FRAG_DIVERGENCE = FRAG_HEAD +
		'uniform sampler2D uVelocity;\n' +
		'void main(){ float L = texture(uVelocity, vL).x, R = texture(uVelocity, vR).x;\n' +
		' float T = texture(uVelocity, vT).y, B = texture(uVelocity, vB).y;\n' +
		' vec2 C = texture(uVelocity, vUv).xy;\n' +
		' if (vL.x < 0.0) L = -C.x; if (vR.x > 1.0) R = -C.x;\n' +
		' if (vT.y > 1.0) T = -C.y; if (vB.y < 0.0) B = -C.y;\n' +
		' fragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0); }';

	var FRAG_CURL = FRAG_HEAD +
		'uniform sampler2D uVelocity;\n' +
		'void main(){ float L = texture(uVelocity, vL).y, R = texture(uVelocity, vR).y;\n' +
		' float T = texture(uVelocity, vT).x, B = texture(uVelocity, vB).x;\n' +
		' fragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0); }';

	var FRAG_VORTICITY = FRAG_HEAD +
		'uniform sampler2D uVelocity, uCurl; uniform float curl; uniform float dt;\n' +
		'void main(){ float L = texture(uCurl, vL).x, R = texture(uCurl, vR).x;\n' +
		' float T = texture(uCurl, vT).x, B = texture(uCurl, vB).x;\n' +
		' float C = texture(uCurl, vUv).x;\n' +
		' vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));\n' +
		' force /= length(force) + 0.0001; force *= curl * C; force.y *= -1.0;\n' +
		' vec2 vel = texture(uVelocity, vUv).xy;\n' +
		' vel += force * dt; vel = clamp(vel, -1000.0, 1000.0);\n' +
		' fragColor = vec4(vel, 0.0, 1.0); }';

	var FRAG_PRESSURE = FRAG_HEAD +
		'uniform sampler2D uPressure, uDivergence;\n' +
		'void main(){ float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x;\n' +
		' float T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;\n' +
		' float divergence = texture(uDivergence, vUv).x;\n' +
		' fragColor = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0); }';

	var FRAG_GRADIENT = FRAG_HEAD +
		'uniform sampler2D uPressure, uVelocity;\n' +
		'void main(){ float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x;\n' +
		' float T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;\n' +
		' vec2 vel = texture(uVelocity, vUv).xy - vec2(R - L, T - B);\n' +
		' fragColor = vec4(vel, 0.0, 1.0); }';

	/* Ink display: density -> soft-saturated alpha; tint preserved; paper-fiber noise */
	var FRAG_DISPLAY = FRAG_HEAD +
		'uniform sampler2D uTexture; uniform float gain;\n' +
		'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }\n' +
		'void main(){ vec3 d = texture(uTexture, vUv).rgb;\n' +
		' float density = max(d.r, max(d.g, d.b));\n' +
		' float a = 1.0 - exp(-density * gain);\n' +
		' a *= 0.9 + 0.1 * hash(vUv * 700.0);\n' +           // paper fiber grain
		' a = clamp(a, 0.0, 0.5);\n' +                        // stay translucent — text must breathe
		' vec3 tint = d / max(density, 0.0001);\n' +
		' vec3 ink = tint * mix(0.55, 0.32, a);\n' +          // darker core, lighter halo
		' fragColor = vec4(ink * a, a); }';

	/* ---------------- GL plumbing ---------------- */
	function compile(type, src) {
		var s = gl.createShader(type);
		gl.shaderSource(s, src); gl.compileShader(s);
		if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw gl.getShaderInfoLog(s);
		return s;
	}
	var vertShader = compile(gl.VERTEX_SHADER, VERT);
	function program(fragSrc) {
		var p = gl.createProgram();
		gl.attachShader(p, vertShader);
		gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSrc));
		gl.linkProgram(p);
		if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw gl.getProgramInfoLog(p);
		var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
		for (var i = 0; i < n; i++) { var info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
		return { prog: p, u: u, bind: function () { gl.useProgram(p); } };
	}

	var progCopy = program(FRAG_COPY);
	var progClear = program(FRAG_CLEAR);
	var progSplat = program(FRAG_SPLAT);
	var progAdvect = program(FRAG_ADVECTION);
	var progDiverge = program(FRAG_DIVERGENCE);
	var progCurl = program(FRAG_CURL);
	var progVort = program(FRAG_VORTICITY);
	var progPressure = program(FRAG_PRESSURE);
	var progGradient = program(FRAG_GRADIENT);
	var progDisplay = program(FRAG_DISPLAY);

	/* fullscreen quad */
	gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
	gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
	gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
	gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
	gl.enableVertexAttribArray(0);

	function blit(target) {
		if (target == null) {
			gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		} else {
			gl.viewport(0, 0, target.width, target.height);
			gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
		}
		gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
	}

	function createFBO(w, h, internalFormat, format, type, filter) {
		var texture = gl.createTexture();
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
		var fbo = gl.createFramebuffer();
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
		gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
		return {
			texture: texture, fbo: fbo, width: w, height: h,
			texelSizeX: 1 / w, texelSizeY: 1 / h,
			attach: function (id) {
				gl.activeTexture(gl.TEXTURE0 + id);
				gl.bindTexture(gl.TEXTURE_2D, texture);
				return id;
			}
		};
	}

	function createDoubleFBO(w, h, iF, f, t, filter) {
		var a = createFBO(w, h, iF, f, t, filter), b = createFBO(w, h, iF, f, t, filter);
		return {
			width: w, height: h, texelSizeX: a.texelSizeX, texelSizeY: a.texelSizeY,
			get read() { return a; }, get write() { return b; },
			swap: function () { var tmp = a; a = b; b = tmp; }
		};
	}

	var dye, velocity, divergence, curl, pressure;

	function getResolution(base) {
		var aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
		if (aspect < 1) aspect = 1 / aspect;
		var min = Math.round(base), max = Math.round(base * aspect);
		return gl.drawingBufferWidth > gl.drawingBufferHeight
			? { width: max, height: min } : { width: min, height: max };
	}

	function initFramebuffers() {
		var sim = getResolution(config.SIM_RESOLUTION);
		var dyeRes = getResolution(config.DYE_RESOLUTION);
		var HF = gl.HALF_FLOAT;
		dye = createDoubleFBO(dyeRes.width, dyeRes.height, gl.RGBA16F, gl.RGBA, HF, gl.LINEAR);
		velocity = createDoubleFBO(sim.width, sim.height, gl.RG16F, gl.RG, HF, gl.LINEAR);
		divergence = createFBO(sim.width, sim.height, gl.R16F, gl.RED, HF, gl.NEAREST);
		curl = createFBO(sim.width, sim.height, gl.R16F, gl.RED, HF, gl.NEAREST);
		pressure = createDoubleFBO(sim.width, sim.height, gl.R16F, gl.RED, HF, gl.NEAREST);
	}

	function resizeCanvas() {
		var dpr = Math.min(window.devicePixelRatio || 1, 2);
		var w = Math.floor(canvas.clientWidth * dpr), h = Math.floor(canvas.clientHeight * dpr);
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w; canvas.height = h;
			return true;
		}
		return false;
	}
	resizeCanvas();
	initFramebuffers();

	/* ---------------- pointer ---------------- */
	var pointer = { x: 0.5, y: 0.5, dx: 0, dy: 0, down: false, moved: false, color: pickInk() };

	function updatePointer(clientX, clientY) {
		var rect = canvas.getBoundingClientRect();
		var x = (clientX - rect.left) / rect.width;
		var y = 1 - (clientY - rect.top) / rect.height;
		pointer.dx = (x - pointer.x) * config.SPLAT_FORCE;
		pointer.dy = (y - pointer.y) * config.SPLAT_FORCE;
		pointer.x = x; pointer.y = y;
		pointer.moved = Math.abs(pointer.dx) > 0.5 || Math.abs(pointer.dy) > 0.5;
	}

	window.addEventListener('pointermove', function (e) { updatePointer(e.clientX, e.clientY); }, { passive: true });
	window.addEventListener('pointerdown', function (e) {
		pointer.color = pickInk();
		updatePointer(e.clientX, e.clientY);
		splat(pointer.x, pointer.y, 0, 0, pointer.color, 4.5); // ink drop on click
	}, { passive: true });
	window.addEventListener('touchmove', function (e) {
		if (e.touches.length > 0) updatePointer(e.touches[0].clientX, e.touches[0].clientY);
	}, { passive: true });

	/* occasionally rotate ink shade while drawing */
	setInterval(function () { if (Math.random() < 0.4) pointer.color = pickInk(); }, 2400);

	/* ---------------- simulation ---------------- */
	function splat(x, y, dx, dy, color, sizeMul) {
		var radius = config.SPLAT_RADIUS * (sizeMul || 1);
		progSplat.bind();
		gl.uniform1i(progSplat.u.uTarget, velocity.read.attach(0));
		gl.uniform1f(progSplat.u.aspectRatio, canvas.width / canvas.height);
		gl.uniform2f(progSplat.u.point, x, y);
		gl.uniform3f(progSplat.u.color, dx, dy, 0);
		gl.uniform1f(progSplat.u.radius, radius);
		blit(velocity.write); velocity.swap();

		gl.uniform1i(progSplat.u.uTarget, dye.read.attach(0));
		var strength = Math.min(0.7, Math.hypot(dx, dy) / 4000 + 0.1);
		gl.uniform3f(progSplat.u.color, color.r * strength, color.g * strength, color.b * strength);
		blit(dye.write); dye.swap();
	}

	function step(dt) {
		gl.disable(gl.BLEND);

		progCurl.bind();
		gl.uniform2f(progCurl.u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
		gl.uniform1i(progCurl.u.uVelocity, velocity.read.attach(0));
		blit(curl);

		progVort.bind();
		gl.uniform2f(progVort.u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
		gl.uniform1i(progVort.u.uVelocity, velocity.read.attach(0));
		gl.uniform1i(progVort.u.uCurl, curl.attach(1));
		gl.uniform1f(progVort.u.curl, config.CURL);
		gl.uniform1f(progVort.u.dt, dt);
		blit(velocity.write); velocity.swap();

		progDiverge.bind();
		gl.uniform2f(progDiverge.u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
		gl.uniform1i(progDiverge.u.uVelocity, velocity.read.attach(0));
		blit(divergence);

		progClear.bind();
		gl.uniform1i(progClear.u.uTexture, pressure.read.attach(0));
		gl.uniform1f(progClear.u.value, config.PRESSURE);
		blit(pressure.write); pressure.swap();

		progPressure.bind();
		gl.uniform2f(progPressure.u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
		gl.uniform1i(progPressure.u.uDivergence, divergence.attach(0));
		for (var i = 0; i < config.PRESSURE_ITERATIONS; i++) {
			gl.uniform1i(progPressure.u.uPressure, pressure.read.attach(1));
			blit(pressure.write); pressure.swap();
		}

		progGradient.bind();
		gl.uniform2f(progGradient.u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
		gl.uniform1i(progGradient.u.uPressure, pressure.read.attach(0));
		gl.uniform1i(progGradient.u.uVelocity, velocity.read.attach(1));
		blit(velocity.write); velocity.swap();

		progAdvect.bind();
		gl.uniform2f(progAdvect.u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
		gl.uniform1i(progAdvect.u.uVelocity, velocity.read.attach(0));
		gl.uniform1i(progAdvect.u.uSource, velocity.read.attach(0));
		gl.uniform1f(progAdvect.u.dt, dt);
		gl.uniform1f(progAdvect.u.dissipation, config.VELOCITY_DISSIPATION);
		blit(velocity.write); velocity.swap();

		gl.uniform1i(progAdvect.u.uVelocity, velocity.read.attach(0));
		gl.uniform1i(progAdvect.u.uSource, dye.read.attach(1));
		gl.uniform1f(progAdvect.u.dissipation, config.DENSITY_DISSIPATION);
		blit(dye.write); dye.swap();
	}

	function render() {
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.clearColor(0, 0, 0, 0);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.clear(gl.COLOR_BUFFER_BIT);
		progDisplay.bind();
		gl.uniform1i(progDisplay.u.uTexture, dye.read.attach(0));
		gl.uniform1f(progDisplay.u.gain, config.INK_GAIN);
		blit(null);
	}

	/* opening ink blooms — a quiet composition on load */
	function openingBlooms() {
		var spots = [
			{ x: 0.88, y: 0.78, s: 5 }, { x: 0.68, y: 0.9, s: 3 },
			{ x: 0.06, y: 0.08, s: 3.5 }, { x: 0.94, y: 0.15, s: 2.5 }
		];
		spots.forEach(function (p, i) {
			setTimeout(function () {
				var c = i === 3 ? { r: 1.0, g: 0.22, b: 0.16 } : pickInk();
				splat(p.x, p.y, (Math.random() - 0.5) * 300, (Math.random() - 0.5) * 300, c, p.s);
			}, 250 + i * 420);
		});
	}
	openingBlooms();

	var lastTime = performance.now();
	var hidden = false;
	document.addEventListener('visibilitychange', function () { hidden = document.hidden; lastTime = performance.now(); });

	function frame(now) {
		requestAnimationFrame(frame);
		if (hidden) return;
		var dt = Math.min((now - lastTime) / 1000, 0.0166);
		lastTime = now;
		if (resizeCanvas()) initFramebuffers();
		if (pointer.moved) {
			pointer.moved = false;
			splat(pointer.x, pointer.y, pointer.dx, pointer.dy, pointer.color, 1);
		}
		step(dt);
		render();
	}
	requestAnimationFrame(frame);

	/* ---------------- 2D fallback ---------------- */
	function fallback2D(cv) {
		var ctx = cv.getContext('2d');
		if (!ctx) { cv.style.display = 'none'; return; }
		var blobs = [];
		function resize() { cv.width = cv.clientWidth; cv.height = cv.clientHeight; }
		resize();
		window.addEventListener('resize', resize);
		window.addEventListener('pointermove', function (e) {
			var rect = cv.getBoundingClientRect();
			blobs.push({ x: e.clientX - rect.left, y: e.clientY - rect.top, r: 6 + Math.random() * 22, life: 1 });
			if (blobs.length > 220) blobs.shift();
		}, { passive: true });
		(function loop() {
			requestAnimationFrame(loop);
			ctx.clearRect(0, 0, cv.width, cv.height);
			for (var i = blobs.length - 1; i >= 0; i--) {
				var b = blobs[i];
				b.life -= 0.008; b.r += 0.25;
				if (b.life <= 0) { blobs.splice(i, 1); continue; }
				var g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
				g.addColorStop(0, 'rgba(30,34,42,' + (0.16 * b.life) + ')');
				g.addColorStop(1, 'rgba(30,34,42,0)');
				ctx.fillStyle = g;
				ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
			}
		})();
	}
})();
