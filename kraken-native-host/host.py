#!/usr/bin/env python3
"""
Kraken Native Host
-------------------
Programa nativo (Native Messaging Host) para la extension "Kraken Video
Catcher". Se conecta por stdin/stdout con el navegador, recibe la URL del
m3u8 (+ cabeceras ya capturadas por la extension), descarga y desencripta
los segmentos a una carpeta temporal, pide al usuario donde guardar el MP4
final, lo genera con ffmpeg y borra la carpeta temporal si todo fue bien.

Requisitos: pip install requests pycryptodome
"""
import sys, os, json, struct, re, time, shutil, subprocess, threading, queue, tempfile
from urllib.parse import urljoin

import tkinter as tk
from tkinter import ttk, filedialog

try:
    import requests
except ImportError:
    requests = None

try:
    from Crypto.Cipher import AES
    HAS_CRYPTO = True
except ImportError:
    HAS_CRYPTO = False

# Si tu ffmpeg no esta en el PATH, pon aqui la ruta completa, ej:
# FFMPEG_PATH = r"C:\herramientas\ffmpeg\bin\ffmpeg.exe"
FFMPEG_PATH = shutil.which('ffmpeg') or shutil.which('ffmpeg.exe')


class Cancelled(Exception):
    pass


# ───────────────────────── Native messaging stdio ─────────────────────────
_stdout_lock = threading.Lock()

def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    msg_len = struct.unpack('<I', raw_len)[0]
    data = b''
    while len(data) < msg_len:
        chunk = sys.stdin.buffer.read(msg_len - len(data))
        if not chunk:
            return None
        data += chunk
    return json.loads(data.decode('utf-8'))

def send_message(obj):
    data = json.dumps(obj).encode('utf-8')
    with _stdout_lock:
        sys.stdout.buffer.write(struct.pack('<I', len(data)))
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


# ───────────────────────── M3U8 parsing ─────────────────────────
def parse_m3u8(text, base_url):
    lines = [l.strip() for l in text.split('\n') if l.strip()]
    segments = []
    is_master = False
    best_variant = None
    best_bw = -1
    key = None
    pending_dur = None
    for i, line in enumerate(lines):
        if line.startswith('#EXT-X-STREAM-INF'):
            is_master = True
            m = re.search(r'BANDWIDTH=(\d+)', line, re.I)
            bw = int(m.group(1)) if m else 0
            if i + 1 < len(lines) and not lines[i + 1].startswith('#') and bw > best_bw:
                best_bw = bw
                nxt = lines[i + 1]
                best_variant = nxt if nxt.startswith('http') else urljoin(base_url, nxt)
        if line.startswith('#EXT-X-KEY'):
            m_method = re.search(r'METHOD=([^,]+)', line, re.I)
            m_uri = re.search(r'URI="([^"]+)"', line, re.I)
            m_iv = re.search(r'IV=(0[xX][0-9a-fA-F]+)', line, re.I)
            method = m_method.group(1) if m_method else None
            if method and method.upper() != 'NONE' and m_uri:
                key = {'method': method, 'uri': m_uri.group(1), 'iv': m_iv.group(1) if m_iv else None}
        if line.startswith('#EXTINF'):
            m = re.search(r'#EXTINF:([\d.]+)', line)
            pending_dur = float(m.group(1)) if m else None
        if not line.startswith('#'):
            ext = line.split('?')[0].lower()
            if any(ext.endswith(e) for e in ('.ts', '.aac', '.mp4', '.m4s', '.m4a', '.fmp4')):
                url = line if line.startswith('http') else urljoin(base_url, line)
                segments.append({'url': url, 'duration': pending_dur})
                pending_dur = None
    return {'is_master': is_master, 'best_variant': best_variant, 'segments': segments, 'key': key}


def pkcs7_unpad(data):
    """Cada segmento HLS-AES128 va paddeado independientemente (PKCS7).
    Si no lo quitamos, quedan bytes de relleno en cada empalme de segmento
    y el .ts resultante sale corrupto."""
    if not data:
        return data
    pad_len = data[-1]
    if 1 <= pad_len <= 16 and data[-pad_len:] == bytes([pad_len]) * pad_len:
        return data[:-pad_len]
    return data


def safe_name(s):
    s = re.sub(r'[\\/:*?"<>|]', '_', s or 'video').strip()
    return s[:80] or 'video'


# ───────────────────────── App ─────────────────────────
class KrakenHostApp:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title('Kraken Native Host')
        self.root.geometry('480x340')
        self.root.protocol('WM_DELETE_WINDOW', self.on_close)

        self.status_var = tk.StringVar(value='🟢 Conectado a la extensión')
        ttk.Label(self.root, textvariable=self.status_var, font=('Segoe UI', 10, 'bold')).pack(pady=(10, 4))

        if requests is None:
            ttk.Label(self.root, text='⚠ Falta "requests" → pip install requests pycryptodome',
                      foreground='red').pack()
        if not FFMPEG_PATH:
            ttk.Label(self.root, text='⚠ No se encontró ffmpeg en el PATH', foreground='#b8860b').pack()

        self.jobs_frame = ttk.Frame(self.root)
        self.jobs_frame.pack(fill='both', expand=True, padx=10, pady=10)
        self.job_widgets = {}  # jobId -> (bar, label)

        self.log = tk.Text(self.root, height=7, state='disabled', font=('Consolas', 8))
        self.log.pack(fill='both', expand=False, padx=10, pady=(0, 10))

        self.ui_queue = queue.Queue()
        self.save_path_queues = {}   # jobId -> queue.Queue() de 1 elemento
        self.cancel_events = {}      # jobId -> threading.Event()
        self.last_dir = os.path.join(os.path.expanduser('~'), 'Downloads')
        if not os.path.isdir(self.last_dir):
            self.last_dir = os.path.expanduser('~')

        self.root.after(80, self.poll_queue)
        threading.Thread(target=self.stdin_loop, daemon=True).start()

    # -------- helpers thread-safe (llamados desde hilos worker) --------
    def log_line(self, text):
        self.ui_queue.put(('log', text))

    def update_progress(self, job_id, loaded, total, status_text):
        self.ui_queue.put(('progress', job_id, loaded, total, status_text))

    def job_finished(self, job_id, ok, message=''):
        self.ui_queue.put(('done', job_id, ok, message))

    def request_save_path(self, job_id, suggested_name):
        """Bloquea el hilo worker hasta que el usuario elige ruta en el hilo principal (Tk)."""
        q = queue.Queue()
        self.save_path_queues[job_id] = q
        self.ui_queue.put(('ask_save_path', job_id, suggested_name))
        return q.get()

    # -------- bucle del hilo principal (Tk) --------
    def poll_queue(self):
        try:
            while True:
                item = self.ui_queue.get_nowait()
                kind = item[0]
                if kind == 'log':
                    self.log.config(state='normal')
                    self.log.insert('end', item[1] + '\n')
                    self.log.see('end')
                    self.log.config(state='disabled')
                elif kind == 'progress':
                    _, job_id, loaded, total, status_text = item
                    self._ensure_job_widget(job_id)
                    bar, lbl = self.job_widgets[job_id]
                    bar['value'] = int(loaded * 100 / total) if total else 0
                    lbl.config(text=status_text)
                elif kind == 'done':
                    _, job_id, ok, message = item
                    if job_id in self.job_widgets:
                        bar, lbl = self.job_widgets[job_id]
                        bar['value'] = 100
                        lbl.config(text=('✅ ' if ok else '❌ ') + message)
                elif kind == 'ask_save_path':
                    _, job_id, suggested_name = item
                    self.log_line(f'👉 Elige dónde guardar "{suggested_name}" (mira si hay una ventana detrás de las demás)')
                    # Traer la ventana (y por tanto el diálogo nativo, que es hijo suyo)
                    # al frente. Si no, el sub-diálogo de "¿reemplazar archivo?" puede
                    # quedar oculto detrás de otra ventana y parece que está colgado.
                    try:
                        self.root.deiconify()
                        self.root.lift()
                        self.root.attributes('-topmost', True)
                        self.root.focus_force()
                        self.root.after(150, lambda: self.root.attributes('-topmost', False))
                    except Exception:
                        pass
                    suggested_name = self._unique_name(self.last_dir, suggested_name)
                    path = filedialog.asksaveasfilename(
                        parent=self.root,
                        title='Guardar vídeo como...',
                        defaultextension='.mp4',
                        initialdir=self.last_dir or None,
                        initialfile=suggested_name,
                        filetypes=[('Vídeo MP4', '*.mp4'), ('Todos los archivos', '*.*')],
                    )
                    if path:
                        self.last_dir = os.path.dirname(path)
                    q = self.save_path_queues.pop(job_id, None)
                    if q:
                        q.put(path or None)
        except queue.Empty:
            pass
        self.root.after(80, self.poll_queue)

    def _ensure_job_widget(self, job_id):
        if job_id in self.job_widgets:
            return
        frame = ttk.Frame(self.jobs_frame)
        frame.pack(fill='x', pady=4)
        lbl = ttk.Label(frame, text='Iniciando...', font=('Segoe UI', 9))
        lbl.pack(anchor='w')
        bar = ttk.Progressbar(frame, maximum=100)
        bar.pack(fill='x')
        self.job_widgets[job_id] = (bar, lbl)

    @staticmethod
    def _unique_name(directory, filename):
        """Si ya existe un archivo con ese nombre en `directory`, sugiere uno libre
        (video.mp4 -> video (1).mp4 -> video (2).mp4...) para no chocar de entrada
        con el dialogo nativo de 'reemplazar archivo', que es el que se queda
        escondido detras de otras ventanas."""
        if not directory or not os.path.isdir(directory):
            return filename
        candidate = filename
        base, ext = os.path.splitext(filename)
        n = 1
        while os.path.exists(os.path.join(directory, candidate)):
            candidate = f'{base} ({n}){ext}'
            n += 1
        return candidate

    # -------- hilo que lee Native Messaging de stdin --------
    def stdin_loop(self):
        while True:
            try:
                msg = read_message()
            except Exception:
                break
            if msg is None:
                break
            mtype = msg.get('type')
            if mtype in ('DOWNLOAD_HLS', 'DOWNLOAD_DIRECT'):
                job_id = msg['jobId']
                ev = threading.Event()
                self.cancel_events[job_id] = ev
                threading.Thread(target=self.run_job, args=(msg, ev), daemon=True).start()
            elif mtype == 'CANCEL':
                ev = self.cancel_events.get(msg.get('jobId'))
                if ev:
                    ev.set()
            elif mtype == 'PING':
                send_message({'type': 'PONG'})
        self.log_line('Desconectado de la extensión, cerrando...')
        self.root.after(800, self.root.destroy)

    # -------- worker: despacha segun tipo --------
    def run_job(self, msg, cancel_event):
        job_id = msg['jobId']
        try:
            if msg.get('type') == 'DOWNLOAD_HLS':
                self.download_and_mux(msg, cancel_event)
            else:
                self.download_direct(msg, cancel_event)
        except Cancelled:
            send_message({'type': 'CANCELLED', 'jobId': job_id})
            self.job_finished(job_id, False, 'Cancelado')
        except Exception as e:
            send_message({'type': 'ERROR', 'jobId': job_id, 'message': str(e)})
            self.job_finished(job_id, False, str(e))
        finally:
            self.cancel_events.pop(job_id, None)

    # -------- HLS: descarga + desencripta + mux con ffmpeg --------
    def download_and_mux(self, msg, cancel_event):
        job_id = msg['jobId']
        m3u8_url = msg['m3u8Url']
        headers = msg.get('headers') or {}
        filename = msg.get('filename') or 'video'

        def progress(loaded, total, status):
            send_message({'type': 'PROGRESS', 'jobId': job_id, 'loaded': loaded, 'total': total, 'statusText': status})
            self.update_progress(job_id, loaded, total, status)

        if requests is None:
            raise RuntimeError('Falta "requests" (pip install requests pycryptodome)')

        sess = requests.Session()
        sess.headers.update({k: v for k, v in headers.items() if v})

        progress(0, 0, 'Leyendo playlist...')
        r1 = sess.get(m3u8_url, timeout=20); r1.raise_for_status()
        parsed = parse_m3u8(r1.text, m3u8_url)
        variant_url = m3u8_url

        if parsed['is_master']:
            if not parsed['best_variant']:
                raise RuntimeError('Master sin variantes')
            variant_url = parsed['best_variant']
            r2 = sess.get(variant_url, timeout=20); r2.raise_for_status()
            parsed = parse_m3u8(r2.text, variant_url)

        segments = parsed['segments']
        if not segments:
            raise RuntimeError('Sin segmentos')
        total = len(segments)
        progress(0, total, f'0 / {total} segmentos')

        key_bytes, iv_template = None, None
        if parsed['key']:
            key_uri = parsed['key']['uri']
            key_url = key_uri if key_uri.startswith('http') else urljoin(variant_url, key_uri)
            kr = sess.get(key_url, timeout=20); kr.raise_for_status()
            key_bytes = kr.content
            if parsed['key']['iv']:
                iv_template = bytes.fromhex(parsed['key']['iv'][2:].zfill(32))
            if not HAS_CRYPTO:
                raise RuntimeError('Stream cifrado y falta pycryptodome (pip install pycryptodome)')

        tmp_dir = os.path.join(tempfile.gettempdir(), 'KrakenCatcher', f'{safe_name(filename)}_{job_id}')
        os.makedirs(tmp_dir, exist_ok=True)
        merged_path = os.path.join(tmp_dir, 'merged.ts')

        with open(merged_path, 'wb') as out_f:
            for i, seg in enumerate(segments):
                if cancel_event.is_set():
                    raise Cancelled()
                data, last_err = None, None
                for attempt in range(3):
                    try:
                        resp = sess.get(seg['url'], timeout=30); resp.raise_for_status()
                        data = resp.content
                        break
                    except Exception as e:
                        last_err = e
                        if attempt < 2:
                            time.sleep(0.8 * (attempt + 1))
                if data is None:
                    raise RuntimeError(f'Segmento {i + 1}: {last_err}')

                if key_bytes:
                    iv = iv_template if iv_template else i.to_bytes(16, 'big')
                    data = pkcs7_unpad(AES.new(key_bytes, AES.MODE_CBC, iv).decrypt(data))

                out_f.write(data)
                progress(i + 1, total, f'{i + 1}/{total} segmentos')

        progress(total, total, 'Elige dónde guardar el MP4...')
        suggested = safe_name(filename).rsplit('.', 1)[0] + '.mp4'
        save_path = self.request_save_path(job_id, suggested)
        if not save_path:
            raise Cancelled()

        total_duration = sum((s.get('duration') or 0) for s in segments) or None

        if FFMPEG_PATH:
            self.run_ffmpeg_with_progress(merged_path, save_path, total_duration, progress)
            final_path = save_path
        else:
            final_path = os.path.splitext(save_path)[0] + '.ts'
            shutil.move(merged_path, final_path)

        send_message({'type': 'DONE', 'jobId': job_id, 'outputPath': final_path})
        self.job_finished(job_id, True, f'Guardado: {final_path}')

        # Solo se borra la carpeta temporal si TODO fue bien
        shutil.rmtree(tmp_dir, ignore_errors=True)

    @staticmethod
    def _fmt_time(secs):
        secs = int(secs or 0)
        h, rem = divmod(secs, 3600)
        m, s = divmod(rem, 60)
        return f'{h:d}:{m:02d}:{s:02d}' if h else f'{m:d}:{s:02d}'

    def run_ffmpeg_with_progress(self, input_path, output_path, total_duration, progress_cb):
        """Lanza ffmpeg con -progress pipe:1 -nostats para tener % real en vez de
        quedarnos a ciegas con subprocess.run(capture_output=True) (que además
        es lo que abría la consola vacía: al no leer nada hasta el final, Windows
        deja la ventana del proceso hijo visible y colgando)."""
        cmd = [FFMPEG_PATH, '-y', '-i', input_path, '-c', 'copy',
               '-progress', 'pipe:1', '-nostats', output_path]
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0

        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, bufsize=1, creationflags=creationflags)

        STALL_SECONDS = 90
        last_progress_at = time.time()
        out_time_secs = 0

        try:
            while True:
                line = proc.stdout.readline()
                if line == '' and proc.poll() is not None:
                    break
                if not line:
                    if time.time() - last_progress_at > STALL_SECONDS:
                        proc.kill()
                        raise RuntimeError(
                            f'ffmpeg no ha dado señales de vida en {STALL_SECONDS}s — '
                            f'lo he detenido. El .ts original sigue en {os.path.dirname(input_path)} '
                            f'por si quieres muxearlo tú a mano.')
                    continue
                line = line.strip()
                if line.startswith('out_time_ms='):
                    try:
                        out_time_secs = int(line.split('=', 1)[1]) / 1_000_000
                    except ValueError:
                        pass
                    if total_duration:
                        pct = max(0, min(99, int(out_time_secs * 100 / total_duration)))
                        progress_cb(pct, 100,
                                    f'Generando MP4... {pct}% ({self._fmt_time(out_time_secs)} / {self._fmt_time(total_duration)})')
                    else:
                        progress_cb(0, 0, f'Generando MP4... {self._fmt_time(out_time_secs)} procesados')
                    last_progress_at = time.time()
                elif line == 'progress=end':
                    break

            try:
                _, stderr_data = proc.communicate(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()
                stderr_data = ''

            if proc.returncode not in (0, None):
                raise RuntimeError('ffmpeg falló: ' + (stderr_data or '')[-500:])

            progress_cb(100, 100, '¡MP4 generado!')
        finally:
            if proc.poll() is None:
                proc.kill()

    # -------- archivo directo (no HLS) --------
    def download_direct(self, msg, cancel_event):
        job_id = msg['jobId']
        url = msg['url']
        headers = msg.get('headers') or {}
        filename = msg.get('filename') or 'video.mp4'

        def progress(loaded, total, status):
            send_message({'type': 'PROGRESS', 'jobId': job_id, 'loaded': loaded, 'total': total, 'statusText': status})
            self.update_progress(job_id, loaded, total, status)

        if requests is None:
            raise RuntimeError('Falta "requests" (pip install requests)')

        sess = requests.Session()
        sess.headers.update({k: v for k, v in headers.items() if v})

        tmp_dir = os.path.join(tempfile.gettempdir(), 'KrakenCatcher', f'{safe_name(filename)}_{job_id}')
        os.makedirs(tmp_dir, exist_ok=True)
        tmp_path = os.path.join(tmp_dir, safe_name(filename))

        progress(0, 0, 'Iniciando descarga...')
        with sess.get(url, stream=True, timeout=30) as r:
            r.raise_for_status()
            total = int(r.headers.get('content-length') or 0)
            loaded = 0
            with open(tmp_path, 'wb') as f:
                for chunk in r.iter_content(chunk_size=1024 * 1024):
                    if cancel_event.is_set():
                        raise Cancelled()
                    if chunk:
                        f.write(chunk)
                        loaded += len(chunk)
                        progress(loaded, total, 'Descargando...')

        progress(loaded, loaded, 'Elige dónde guardar...')
        save_path = self.request_save_path(job_id, safe_name(filename))
        if not save_path:
            raise Cancelled()

        shutil.move(tmp_path, save_path)
        send_message({'type': 'DONE', 'jobId': job_id, 'outputPath': save_path})
        self.job_finished(job_id, True, f'Guardado: {save_path}')
        shutil.rmtree(tmp_dir, ignore_errors=True)

    def on_close(self):
        self.root.destroy()

    def run(self):
        self.root.mainloop()


if __name__ == '__main__':
    KrakenHostApp().run()
