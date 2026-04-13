
# 1. Definir la música de relleno (asegúrate de subir un fondo.mp3)
musica = single("/app/fondo.mp3")

# 2. Definir el espacio para el DJ IA
# Revisa si existe el archivo 'salida.mp3' generado por Node.js
dj_ia = request.dynamic({ 
  if file.exists("/app/salida.mp3") then 
    request.create("/app/salida.mp3") 
  else 
    null() 
  end 
})

# 3. La lógica de prioridad
# track_sensitive=false permite que el DJ entre apenas el archivo esté listo
radio = fallback(track_sensitive=false, [dj_ia, musica])

# 4. Salida hacia AzuraCast
  output.icecast(%mp3,
  host = "az.azurafree.eu",
  port = 8225,
  password = "fronterisima", # <--- Cambia esto
  mount = "/",
  radio)
