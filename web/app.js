"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const elements = {
    cockpit: $("cockpit"), speed: $("speed-value"), caption: $("speed-caption"),
    count: $("request-count"), gear: $("gear-status"), status: $("status-text"),
    total: $("total-value"), average: $("average-value"), byteRate: $("byte-rate-value"),
    form: $("test-form"), url: $("target-url"), start: $("start-button"), cancel: $("cancel-button"),
    demo: $("demo-button"), demoBadge: $("demo-badge"), chart: $("request-chart"),
    table: $("request-table"), subtitle: $("results-subtitle"), success: $("success-text"),
    export: $("export-button"), error: $("error-banner"), errorText: $("error-text"),
    retry: $("retry-button"), connection: $("connection-pill"), connectionText: $("connection-text"),
    announce: $("result-announcement"), max: $("scale-max"),
  };
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const decimal = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const speedScaleTicks = document.querySelectorAll('g.scale-numbers[fill="#4f94bb"] text');
  let generation = 0;
  let timer = null;
  let animation = null;
  let shownSpeed = 0;
  let token = "";
  let online = false;
  let mode = "real";
  let actionPending = false;
  let cancelRequested = false;
  let state = readyState();
  let announcedStatus = "";

  function readyState() {
    return { status: "ready", index: 0, live_mbps: 0, samples: [], stats: { successful: 0, failed: 0, total_bytes: 0, total_seconds: 0, avg_seconds: 0, mbps: 0, MBps: 0 }, error: null };
  }
  function number(value) { const result = Number(value); return Number.isFinite(result) && result > 0 ? result : 0; }
  function setConnection(connected) {
    online = connected;
    elements.connection.classList.toggle("online", connected);
    elements.connection.classList.toggle("offline", !connected);
    elements.connectionText.textContent = connected ? "Локальный сервер" : "Сервер недоступен";
  }
  function clearTimer() { if (timer !== null) window.clearTimeout(timer); timer = null; }
  function displayError(message, reconnect = false) {
    elements.errorText.textContent = message;
    elements.error.hidden = false;
    elements.retry.hidden = !reconnect;
  }
  function clearError() { elements.error.hidden = true; elements.errorText.textContent = ""; }
  function humanError(message) {
    const text = String(message || "Не удалось выполнить запрос.");
    if (/request exceeded its time limit/i.test(text)) return "Загрузка заняла слишком много времени. Попробуй файл поменьше или другой сервер.";
    if (/connection failed:/i.test(text)) return "Не удалось подключиться к серверу загрузки. Проверь интернет и адрес файла.";
    if (/url must not include a username or password/i.test(text)) return "В адресе не должно быть логина или пароля. Вставь публичную прямую ссылку на файл.";
    if (/response exceeds.*size limit/i.test(text)) return "Файл превышает допустимый размер. Выбери ссылку на файл поменьше.";
    if (/incomplete response/i.test(text)) return "Сервер прервал загрузку: получен не весь файл. Попробуй другой адрес.";
    if (/response body is empty/i.test(text)) return "Сервер вернул пустой файл. Выбери прямую ссылку на файл с данными.";
    if (/^cancelled\.?$/i.test(text)) return "Загрузка остановлена.";
    if (/failed to fetch|networkerror|abort|timed out|timeout/i.test(text)) return "Нет ответа от сервера. Проверь соединение или попробуй другой адрес.";
    if (/only.*https?|http.*https.*only|unsupported.*scheme|must.*https?/i.test(text)) return "Вставь полный адрес файла, начинающийся с http:// или https://.";
    if (/invalid.*url|url.*invalid|url.*required|missing.*url/i.test(text)) return "Проверь адрес: нужна прямая ссылка на доступный файл.";
    if (/already.*running|test.*running/i.test(text)) return "Тест уже запущен. Дождись завершения или останови его.";
    if (/token|forbidden|csrf/i.test(text)) return "Сессия обновилась. Переподключись и запусти тест ещё раз.";
    if (/http error.*403|http.*403/i.test(text)) return "Сервер запретил загрузку (HTTP 403). Попробуй другой адрес.";
    if (/http error.*404|http.*404/i.test(text)) return "Файл не найден (HTTP 404). Проверь прямую ссылку.";
    return text;
  }

  async function request(path, body) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST", cache: "no-store", signal: controller.signal,
        headers: body === undefined ? {} : { "Content-Type": "application/json", "X-Speedometer-Token": token },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let payload;
      try { payload = await response.json(); } catch { throw new Error("Локальный сервер вернул некорректный ответ. Перезапусти приложение."); }
      if (!response.ok) throw new Error(payload.error || payload.message || `Ошибка локального сервера (HTTP ${response.status}).`);
      return payload;
    } finally { window.clearTimeout(timeout); }
  }

  function paintSpeed(value) {
    shownSpeed = Math.max(0, value);
    const [whole, fraction] = shownSpeed.toFixed(1).split(".");
    const decimalPart = document.createElement("span");
    decimalPart.textContent = `.${fraction}`;
    elements.speed.replaceChildren(document.createTextNode(whole), decimalPart);
    const maximum = Math.max(1000, Math.ceil(shownSpeed / 500) * 500);
    elements.max.textContent = maximum.toString();
    speedScaleTicks.forEach((tick, index) => { tick.textContent = String(Math.round(maximum * [0, .1, .2, .4, .6, .8][index])); });
    const fill = Math.min(100, shownSpeed / maximum * 100);
    $("speed-fill").setAttribute("stroke-dasharray", `${fill.toFixed(2)} 100`);
    $("speed-glow").setAttribute("stroke-dasharray", `${fill.toFixed(2)} 100`);
  }
  function animateSpeed(target) {
    if (animation !== null) window.cancelAnimationFrame(animation);
    if (reducedMotion || Math.abs(target - shownSpeed) < 0.05) { paintSpeed(target); return; }
    const start = shownSpeed;
    const began = performance.now();
    function frame(now) {
      const progress = Math.min(1, (now - began) / 320);
      const eased = 1 - Math.pow(1 - progress, 3);
      paintSpeed(start + (target - start) * eased);
      if (progress < 1) animation = window.requestAnimationFrame(frame); else animation = null;
    }
    animation = window.requestAnimationFrame(frame);
  }

  const chartBars = Array.from({ length: 10 }, (_, i) => {
    const item = document.createElement("li");
    const stack = document.createElement("div"); stack.className = "bar-stack";
    const value = document.createElement("span"); value.className = "bar-value";
    const bar = document.createElement("div"); bar.className = "bar";
    const label = document.createElement("span"); label.className = "bar-label"; label.textContent = String(i + 1).padStart(2, "0");
    stack.append(value, bar); item.append(stack, label); elements.chart.append(item);
    return { item, value, bar };
  });

  function renderSamples(samples, running) {
    const maximum = Math.max(1, ...samples.filter((sample) => !sample.error).map((sample) => number(sample.mbps)));
    chartBars.forEach(({ item, value, bar }, i) => {
      const sample = samples[i];
      const active = !sample && running && samples.length === i && !cancelRequested;
      bar.className = `bar${sample ? (sample.error ? " failed" : " measured") : (active ? " active" : "")}`;
      if (sample) {
        bar.style.height = `${sample.error ? 5 : Math.max(6, number(sample.mbps) / maximum * 80)}px`;
        value.textContent = sample.error ? "×" : number(sample.mbps).toFixed(1);
        item.setAttribute("aria-label", `Запрос ${i + 1}: ${sample.error ? humanError(sample.error) : `${decimal.format(number(sample.mbps))} Мбит/с`}`);
      } else {
        bar.style.height = active ? "18px" : "3px";
        value.textContent = active ? "···" : "";
        item.setAttribute("aria-label", `Запрос ${i + 1}: ${active ? "выполняется" : "ожидает"}`);
      }
    });
    const rows = samples.map((sample, i) => {
      const row = document.createElement("tr"); row.className = sample.error ? "row-error" : "row-ok";
      const values = [String(sample.index || i + 1).padStart(2, "0"), decimal.format(number(sample.bytes) / 1e6), decimal.format(number(sample.elapsed_s)), sample.error ? "—" : decimal.format(number(sample.mbps)), sample.error ? humanError(sample.error) : "Успешно"];
      values.forEach((text) => { const cell = document.createElement("td"); cell.textContent = text; row.append(cell); });
      return row;
    });
    if (!rows.length) {
      const row = document.createElement("tr"); const cell = document.createElement("td");
      cell.colSpan = 5; cell.textContent = "Здесь появятся результаты десяти последовательных запросов."; row.append(cell); rows.push(row);
    }
    elements.table.replaceChildren(...rows);
  }

  function render(next) {
    state = next;
    const stats = next.stats || readyState().stats;
    const samples = Array.isArray(next.samples) ? next.samples : [];
    const running = next.status === "running";
    const complete = next.status === "completed";
    const count = Math.min(10, samples.length);
    const demo = mode === "demo";
    const speed = running ? number(next.live_mbps) : number(stats.mbps);
    elements.cockpit.classList.toggle("running", running);
    elements.demoBadge.hidden = !demo;
    animateSpeed(speed);
    elements.count.textContent = String(count);
    elements.total.textContent = decimal.format(number(stats.total_bytes) / 1e6);
    elements.average.textContent = decimal.format(number(stats.avg_seconds));
    elements.byteRate.textContent = decimal.format(number(stats.MBps));
    elements.subtitle.textContent = `${count} из 10${demo ? " · демо" : ""}`;
    const progress = count * 10;
    $("progress-fill").setAttribute("stroke-dasharray", `${progress} 100`);
    $("progress-glow").setAttribute("stroke-dasharray", `${progress} 100`);
    elements.url.disabled = running || actionPending;
    elements.start.hidden = running;
    elements.cancel.hidden = !running;
    elements.start.disabled = actionPending || !online || !token;
    elements.cancel.disabled = actionPending || cancelRequested;
    elements.cancel.firstElementChild.textContent = cancelRequested ? "Останавливаем…" : "Остановить";
    elements.demo.disabled = running || actionPending;
    elements.export.disabled = !samples.length || running;
    elements.form.setAttribute("aria-busy", String(actionPending));
    elements.success.textContent = samples.length ? `${number(stats.successful)} успешно${stats.failed ? ` · ${stats.failed} с ошибкой` : ""}` : "Ожидание первого запроса";
    const prefix = demo ? "Демо · " : "";
    const current = Math.min(10, count + 1);
    if (running) {
      elements.gear.textContent = cancelRequested ? "STOPPING" : "RUNNING";
      elements.caption.textContent = demo ? "Вымышленные данные" : "Скорость текущей загрузки";
      elements.status.textContent = cancelRequested ? `${prefix}Ожидаем остановки текущей загрузки…` : `${prefix}Загрузка ${current} из 10${demo ? " · без сетевых запросов" : " · один поток"}`;
    } else if (complete) {
      elements.gear.textContent = demo ? "DEMO DONE" : "COMPLETE";
      elements.caption.textContent = demo ? "Вымышленная средняя скорость" : "Средняя скорость за 10 запросов";
      elements.status.textContent = demo ? "Демо завершено · это не измерение интернета" : "Тест завершён · результат готов";
    } else if (next.status === "cancelled") {
      elements.gear.textContent = "STOPPED";
      elements.caption.textContent = "Среднее по завершённым загрузкам";
      elements.status.textContent = `${prefix}Тест остановлен · ${count} из 10 запросов завершено`;
    } else if (next.status === "partial") {
      elements.gear.textContent = "PARTIAL";
      elements.caption.textContent = "Среднее по успешным загрузкам";
      elements.status.textContent = `${prefix}Тест завершён с ошибками · частичный результат`;
    } else if (next.status === "error") {
      elements.gear.textContent = "ERROR";
      elements.caption.textContent = "Не удалось измерить скорость";
      elements.status.textContent = "Проверь адрес и попробуй снова";
    } else {
      elements.gear.textContent = "READY";
      elements.caption.textContent = "Готов к старту";
      elements.status.textContent = online ? "Всё готово · можно начинать" : "Подключаемся к локальному серверу";
    }
    if (next.error) displayError(humanError(next.error), false);
    else if (next.status === "partial") displayError("Часть загрузок завершилась с ошибкой. Средняя скорость рассчитана только по успешным запросам; подробности — ниже.", false);
    renderSamples(samples, running);
    const announcementKey = `${next.id || generation}:${next.status}`;
    if (!running && next.status !== "ready" && announcedStatus !== announcementKey) {
      announcedStatus = announcementKey;
      elements.announce.textContent = `${demo ? "Демо. " : ""}${elements.status.textContent}. Средняя скорость ${decimal.format(number(stats.mbps))} мегабит в секунду.`;
    }
  }

  async function poll(myGeneration) {
    try {
      const next = await request("/api/status");
      if (myGeneration !== generation || mode !== "real") return;
      token = next.token || token;
      setConnection(true);
      clearError();
      if (next.status !== "running") cancelRequested = false;
      render(next);
      if (next.status === "running") timer = window.setTimeout(() => poll(myGeneration), 250);
    } catch (error) {
      if (myGeneration !== generation || mode !== "real") return;
      setConnection(false);
      actionPending = false;
      elements.start.disabled = true;
      elements.cancel.disabled = false;
      elements.demo.disabled = false;
      elements.cockpit.classList.remove("running");
      elements.status.textContent = "Соединение с локальным сервером потеряно";
      elements.gear.textContent = "OFFLINE";
      displayError("Локальный сервер недоступен. Убедись, что окно запуска открыто, затем нажми «Переподключить».", true);
    }
  }

  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (actionPending || state.status === "running") return;
    const url = elements.url.value.trim();
    try { const parsed = new URL(url); if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("protocol"); }
    catch { displayError("Вставь прямую ссылку на файл: она должна начинаться с https:// или http://."); elements.url.focus(); return; }
    clearTimer(); generation += 1; const myGeneration = generation;
    mode = "real"; state = readyState(); actionPending = true; cancelRequested = false; clearError(); render(state);
    elements.start.firstElementChild.textContent = "Запускаем…";
    try {
      const next = await request("/api/start", { url });
      if (myGeneration !== generation) return;
      token = next.token || token; setConnection(true); actionPending = false;
      render(next);
      if (next.status === "running") timer = window.setTimeout(() => poll(myGeneration), 250);
    } catch (error) {
      if (myGeneration !== generation) return;
      actionPending = false; render(state); displayError(humanError(error.message), /token|forbidden|fetch|abort/i.test(error.message));
    } finally { elements.start.firstElementChild.textContent = "Начать тест"; }
  });

  elements.cancel.addEventListener("click", async () => {
    if (actionPending || cancelRequested) return;
    if (mode === "demo") {
      clearTimer(); generation += 1; cancelRequested = false;
      render({ ...state, status: "cancelled", live_mbps: 0 }); return;
    }
    generation += 1;
    const myGeneration = generation;
    cancelRequested = true; actionPending = true; render(state); clearTimer();
    try {
      const next = await request("/api/cancel", {});
      if (myGeneration !== generation) return;
      actionPending = false; if (next.status !== "running") cancelRequested = false;
      render(next);
      if (next.status === "running") timer = window.setTimeout(() => poll(myGeneration), 250);
    } catch (error) {
      if (myGeneration !== generation) return;
      actionPending = false; cancelRequested = false; render(state);
      displayError(humanError(error.message), true);
    }
  });

  elements.demo.addEventListener("click", () => {
    if (actionPending || (online && state.status === "running")) return;
    clearTimer(); generation += 1; const myGeneration = generation;
    mode = "demo"; cancelRequested = false; actionPending = false; clearError();
    const demoState = { ...readyState(), id: `demo-${Date.now()}`, status: "running", url: "demo://synthetic-data" };
    render(demoState);
    const elapsed = [.55, .43, .41, .47, .40, .44, .39, .42, .45, .41];
    let frame = 0;
    function demoStep() {
      if (myGeneration !== generation || mode !== "demo") return;
      const index = demoState.samples.length;
      const phase = frame % 3;
      demoState.live_mbps = 40 / elapsed[Math.min(9, index)] * (.54 + phase * .23);
      frame += 1;
      if (frame % 3 === 0) {
        const elapsed_s = elapsed[index];
        demoState.samples.push({ index: index + 1, bytes: 5000000, elapsed_s, mbps: 40 / elapsed_s, MBps: 5 / elapsed_s, error: null });
        const total_seconds = demoState.samples.reduce((sum, sample) => sum + sample.elapsed_s, 0);
        const total_bytes = demoState.samples.length * 5000000;
        demoState.index = demoState.samples.length;
        demoState.stats = { successful: demoState.samples.length, failed: 0, total_bytes, total_seconds, avg_seconds: total_seconds / demoState.samples.length, mbps: total_bytes * 8 / total_seconds / 1e6, MBps: total_bytes / total_seconds / 1e6 };
      }
      if (demoState.samples.length === 10) demoState.status = "completed";
      render(demoState);
      if (demoState.status === "running") timer = window.setTimeout(demoStep, 260);
    }
    timer = window.setTimeout(demoStep, 260);
  });

  elements.retry.addEventListener("click", () => {
    clearTimer(); generation += 1; mode = "real"; actionPending = false; cancelRequested = false; clearError();
    elements.connectionText.textContent = "Подключение…";
    poll(generation);
  });
  elements.export.addEventListener("click", () => {
    if (!state.samples?.length) return;
    const result = { ...state, mode: mode === "demo" ? "demo_synthetic_not_an_internet_measurement" : "real_download", exported_at: new Date().toISOString() };
    delete result.token;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = `speedometer-${mode}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  render(state);
  poll(generation);
})();
