export const commands = [
  {
    name: "new",
    label: "Nueva conversación",
    detail: "Empieza con un contexto vacío",
    group: "Conversación",
    action: "new",
  },
  {
    name: "rename",
    label: "Renombrar",
    detail: "Cambia el título de esta conversación",
    group: "Conversación",
    action: "rename",
  },
  {
    name: "export",
    label: "Exportar conversación",
    detail: "Descarga el historial en Markdown",
    group: "Conversación",
    action: "export",
  },
  {
    name: "stop",
    label: "Detener respuesta",
    detail: "Cancela la generación actual",
    group: "Conversación",
    action: "stop",
  },
  {
    name: "theme",
    label: "Cambiar apariencia",
    detail: "Claro, oscuro o según el sistema",
    group: "Interfaz",
    action: "theme",
  },
  {
    name: "help",
    label: "Comandos y atajos",
    detail: "Descubre cómo trabajar en el chat",
    group: "Interfaz",
    action: "help",
  },
  {
    name: "connect",
    label: "Conexión del CLI",
    detail: "Consulta la cuenta y cómo cambiarla en el CLI",
    group: "Conexión",
    action: "connection",
  },
  {
    name: "models",
    label: "Modelo del CLI",
    detail: "Consulta el modelo; se selecciona con /models en el CLI",
    group: "Conexión",
    action: "connection",
  },
  {
    name: "variants",
    label: "Razonamiento del CLI",
    detail: "Se configura con /variants en el CLI",
    group: "Conexión",
    action: "connection",
  },
  {
    name: "status",
    label: "Estado del proyecto",
    detail: "Prepara una consulta de trabajos y nodos",
    group: "Consultas al agente",
    action: "prompt",
    prompt:
      "Consulta el estado del proyecto, trabajos y nodos. Describe solamente lo que puedas verificar sin ejecutar cambios.",
  },
  {
    name: "protocols",
    label: "Protocolos disponibles",
    detail: "Prepara una consulta del catálogo científico",
    group: "Consultas al agente",
    action: "prompt",
    prompt:
      "Lista los protocolos científicos disponibles con sus usos, limitaciones y estado de revisión.",
  },
  {
    name: "results",
    label: "Resultados y registros",
    detail: "Prepara una consulta de evidencias",
    group: "Consultas al agente",
    action: "prompt",
    prompt:
      "Inspecciona los resultados y registros disponibles y explica qué evidencias hay, sin modificar archivos ni ejecutar cálculos.",
  },
] as const;
export type Command = (typeof commands)[number];
export function filterCommands(query: string) {
  const needle = query.replace(/^\//, "").trim().toLocaleLowerCase();
  return commands
    .filter((c) => `${c.name} ${c.label} ${c.group}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => Number(b.name.startsWith(needle)) - Number(a.name.startsWith(needle)));
}
export type Theme = "light" | "dark" | "system";
export function resolveTheme(theme: Theme, darkSystem: boolean) {
  return theme === "system" ? (darkSystem ? "dark" : "light") : theme;
}
