# Kraken Native Host

Programa nativo en Python que la extensión "Kraken Video Catcher" usa para
descargar y generar el MP4 final **sin pasar por chrome.downloads** (cero
diálogos de descarga). Descarga los segmentos a una carpeta temporal,
desencripta si hace falta, te deja elegir dónde guardar el MP4, lo genera
con ffmpeg, y borra la carpeta temporal si todo salió bien.

## Requisitos

- **Python 3** instalado y en el PATH (marca "Add to PATH" al instalarlo).
- **ffmpeg** en el PATH (si no lo está, el programa avisa y deja el `.ts`
  sin remuxear; puedes fijar la ruta a mano editando `FFMPEG_PATH` al
  principio de `host.py`).
- Google Chrome con la extensión Kraken Video Catcher cargada.

## Instalación

1. Copia esta carpeta entera (`kraken-native-host`) a un sitio fijo en tu
   disco — **no la muevas después de instalar**, porque el registro de
   Windows queda apuntando a esta ruta exacta.
2. Abre `chrome://extensions`, activa "Modo de desarrollador" si no lo
   está, y copia el **ID** que aparece bajo "Kraken Video Catcher"
   (una cadena tipo `abcdefghijklmnopabcdefghijklmnop`).
3. Haz doble clic en `install.bat` y pega ese ID cuando te lo pida.
   El instalador:
   - instala `requests` y `pycryptodome` con pip,
   - escribe `com.krakencatcher.host.json` con la ruta absoluta correcta,
   - registra el host en
     `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.krakencatcher.host`.
4. Recarga la extensión en `chrome://extensions` y prueba a descargar un
   vídeo. Debería abrirse una ventanita "Kraken Native Host" mostrando el
   progreso, y al terminar te pedirá dónde guardar el `.mp4`.

## Si algo falla

- Si no tienes el host instalado (o falla la conexión), la extensión cae
  automáticamente al método de respaldo (zips vía `chrome.downloads`) —
  no se rompe nada, simplemente pierdes la ventaja de cero diálogos.
- Si cancelas un trabajo o algo falla a mitad de la descarga, la carpeta
  temporal **no se borra** (queda en
  `%TEMP%\KrakenCatcher\<nombre>_<id>\merged.ts`) para que puedas
  inspeccionarla o recuperarla a mano.
- Si mueves la carpeta del programa, vuelve a ejecutar `install.bat`.
- Si cambias el ID de la extensión (por ejemplo porque moviste también la
  carpeta de la extensión), también tienes que reinstalar.

## Cómo funciona (protocolo)

La extensión llama a `chrome.runtime.connectNative('com.krakencatcher.host')`
y manda un mensaje JSON:

```json
{"type":"DOWNLOAD_HLS","jobId":"...","m3u8Url":"...","headers":{...},"filename":"..."}
```

El host responde con mensajes de progreso:

```json
{"type":"PROGRESS","jobId":"...","loaded":120,"total":749,"statusText":"120/749 segmentos"}
```

Y al terminar:

```json
{"type":"DONE","jobId":"...","outputPath":"C:\\Users\\...\\video.mp4"}
```

o, si algo falla:

```json
{"type":"ERROR","jobId":"...","message":"..."}
```

## Linux

Use `install.sh` instead of `install.bat` (requires `python3`, `python3-venv`,
`python3-tk` and ideally `ffmpeg`). It creates a `.venv` next to the host,
installs `requests` and `pycryptodome` into it, and writes the native messaging
manifest for each supported browser under `~/.config`. `host.sh` is the
launcher. Run `./uninstall.sh` to remove everything. See the project README
for details.
