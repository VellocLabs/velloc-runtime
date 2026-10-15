---
# Welcome page for the `safe_code` type - es variant. See `welcome.md` for the
# structure; only user-visible values are translated.
greeting: ¿Qué quiere que lea o cambie?
suggestions:
  - title: Entender este código
    description: Explore la arquitectura, los módulos y los flujos importantes.
    prompt: Ayúdeme a entender este código. Identifique los componentes principales, los puntos de entrada importantes, el flujo de datos y las partes que debería leer primero.
  - title: Revisar código
    description: Encuentre errores, riesgos y oportunidades de mejora.
    prompt: Revise este código en cuanto a corrección, errores, regresiones, riesgos de seguridad, problemas de rendimiento y mantenibilidad. Ponga primero los hallazgos más importantes.
  - title: Corregir un error
    description: Encuentre la causa raíz y haga el cambio mínimo seguro.
    prompt: Investigue este error leyendo el código, identifique la causa raíz y aplique la corrección mínima y fiable. Compruebe el cambio releyendo los archivos afectados en lugar de ejecutar nada, y dígame qué queda por ejecutar fuera de SafeCode.
  - title: Crear una función
    description: Aplique el cambio en todos los archivos implicados.
    prompt: Ayúdeme a crear una nueva función en este proyecto. Lea primero el código y la arquitectura relevantes, después proponga un plan de implementación y haga los cambios. Compruebe el resultado inspeccionando los archivos resultantes y enumere qué queda por compilar o probar fuera de SafeCode.
  - title: Refactorizar código
    description: Mejore la estructura sin cambiar el comportamiento.
    prompt: Refactorice este código para que sea más simple, más claro y más fácil de mantener, conservando el comportamiento actual. Explique los cambios principales y compruebe leyendo que nada más dependa de lo que ha movido.
  - title: Escribir pruebas
    description: Escríbalas aquí, ejecútelas en otro sitio.
    prompt: Lea el comportamiento actual y las pruebas existentes, identifique las lagunas y los casos límite importantes, y escriba pruebas que los cubran. Siga el estilo de las pruebas de alrededor. Yo las ejecutaré fuera de SafeCode.
---
