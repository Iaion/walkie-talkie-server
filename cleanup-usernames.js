// cleanup-usernames.js - Versión que usa variables de entorno
console.log('🧹 Iniciando limpieza de usernames "null"...');
console.log('📂 Carpeta actual:', process.cwd());

// ============================================================
// 🔌 IMPORTAR DEPENDENCIAS
// ============================================================
const admin = require('firebase-admin');

// ============================================================
// 🎨 COLORES PARA CONSOLA
// ============================================================
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m"
};

// ============================================================
// 🔥 INICIALIZAR FIREBASE (IGUAL QUE TU SERVIDOR)
// ============================================================
async function inicializarFirebase() {
  console.log('🔍 Verificando variables de entorno...');
  
  // Verificar que existen las variables
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error(`${colors.red}❌ GOOGLE_APPLICATION_CREDENTIALS no está definida${colors.reset}`);
    console.log(`${colors.yellow}📌 Las variables de entorno disponibles son:${colors.reset}`);
    console.log(Object.keys(process.env).filter(key => !key.includes('=')).sort().join(', '));
    return false;
  }
  
  if (!process.env.FIREBASE_STORAGE_BUCKET) {
    console.error(`${colors.red}❌ FIREBASE_STORAGE_BUCKET no está definida${colors.reset}`);
    return false;
  }
  
  try {
    console.log(`${colors.green}✅ Variables de entorno encontradas${colors.reset}`);
    
    // Parsear el JSON de la variable de entorno
    const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    
    // Inicializar Firebase
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET
    });
    
    admin.firestore().settings({ ignoreUndefinedProperties: true });
    console.log(`${colors.green}✅ Firebase inicializado correctamente con variables de entorno${colors.reset}`);
    return true;
    
  } catch (error) {
    console.error(`${colors.red}❌ Error al inicializar Firebase:${colors.reset}`, error.message);
    return false;
  }
}

// ============================================================
// 📊 FUNCIÓN PARA VERIFICAR USUARIOS
// ============================================================
async function verificarUsuarios(db) {
  console.log(`\n${colors.cyan}🔍 VERIFICANDO USUARIOS...${colors.reset}`);
  
  try {
    // Buscar username = "null" (string)
    const snapshot1 = await db.collection('users').where('username', '==', 'null').get();
    
    // Buscar username = null (valor nulo)
    const snapshot2 = await db.collection('users').where('username', '==', null).get();
    
    // Buscar username = "" (vacío)
    const snapshot3 = await db.collection('users').where('username', '==', '').get();
    
    console.log(`${colors.blue}📊 RESULTADOS:${colors.reset}`);
    console.log(`   Username = "null" (string): ${snapshot1.size} usuarios`);
    console.log(`   Username = null (valor nulo): ${snapshot2.size} usuarios`);
    console.log(`   Username = "" (vacío): ${snapshot3.size} usuarios`);
    console.log(`   ${colors.yellow}TOTAL: ${snapshot1.size + snapshot2.size + snapshot3.size} usuarios con problemas${colors.reset}`);
    
    // Mostrar ejemplos si hay
    if (snapshot1.size > 0) {
      console.log(`\n${colors.yellow}📋 Ejemplos de usuarios con "null":${colors.reset}`);
      snapshot1.docs.slice(0, 5).forEach((doc, i) => {
        const data = doc.data();
        console.log(`   ${i+1}. ID: ${doc.id}`);
        console.log(`      fullName: ${data.fullName || 'N/A'}`);
        console.log(`      email: ${data.email || 'N/A'}`);
      });
    }
    
    return {
      stringNull: snapshot1.size,
      realNull: snapshot2.size,
      empty: snapshot3.size,
      total: snapshot1.size + snapshot2.size + snapshot3.size,
      docs: [...snapshot1.docs, ...snapshot2.docs, ...snapshot3.docs]
    };
    
  } catch (error) {
    console.error(`${colors.red}❌ Error en verificación:${colors.reset}`, error);
    throw error;
  }
}

// ============================================================
// 🧹 FUNCIÓN DE LIMPIEZA
// ============================================================
async function limpiarUsuarios(db) {
  console.log(`\n${colors.magenta}🧹 INICIANDO LIMPIEZA DE USERNAMES${colors.reset}`);
  
  const stats = {
    procesados: 0,
    reparados: 0,
    errores: 0,
    inicio: Date.now()
  };
  
  try {
    const verificacion = await verificarUsuarios(db);
    
    if (verificacion.total === 0) {
      console.log(`\n${colors.green}✅ No hay usuarios que reparar. Todo OK!${colors.reset}`);
      return;
    }
    
    console.log(`\n${colors.yellow}⚠️ Se encontraron ${verificacion.total} usuarios con problemas${colors.reset}`);
    console.log(`${colors.cyan}⏳ Comenzando reparación...${colors.reset}\n`);
    
    const FieldValue = admin.firestore.FieldValue;
    
    for (const doc of verificacion.docs) {
      stats.procesados++;
      const data = doc.data();
      const userId = doc.id;
      
      console.log(`${colors.gray}────────────────────────────────────${colors.reset}`);
      console.log(`${colors.blue}👤 Procesando: ${userId}${colors.reset}`);
      console.log(`   Username actual: "${data.username}"`);
      
      // Determinar nuevo username
      let nuevoUsername = null;
      let fuente = "";
      
      if (data.fullName && data.fullName.trim() && data.fullName !== "null") {
        nuevoUsername = data.fullName.trim();
        fuente = "fullName";
      } else if (data.displayName && data.displayName.trim() && data.displayName !== "null") {
        nuevoUsername = data.displayName.trim();
        fuente = "displayName";
      } else if (data.email && data.email.trim() && data.email !== "null") {
        nuevoUsername = data.email.split('@')[0].trim();
        fuente = "email";
      } else {
        nuevoUsername = `Usuario_${userId.slice(-6)}`;
        fuente = "generado";
      }
      
      console.log(`   ${colors.green}Nuevo username: "${nuevoUsername}" (desde ${fuente})${colors.reset}`);
      
      try {
        await doc.ref.update({
          username: nuevoUsername,
          usernameFixed: true,
          usernameFixedAt: FieldValue.serverTimestamp(),
          previousUsername: data.username
        });
        
        console.log(`   ${colors.green}✅ Reparado correctamente${colors.reset}`);
        stats.reparados++;
        
      } catch (updateError) {
        console.error(`   ${colors.red}❌ Error actualizando:${colors.reset}`, updateError.message);
        stats.errores++;
      }
    }
    
    const tiempoTotal = (Date.now() - stats.inicio) / 1000;
    
    console.log(`\n${colors.cyan}════════════════════════════════════${colors.reset}`);
    console.log(`${colors.green}✅ LIMPIEZA COMPLETADA${colors.reset}`);
    console.log(`${colors.blue}   Usuarios procesados: ${stats.procesados}${colors.reset}`);
    console.log(`${colors.green}   Reparados exitosamente: ${stats.reparados}${colors.reset}`);
    console.log(`${colors.red}   Errores: ${stats.errores}${colors.reset}`);
    console.log(`${colors.magenta}   Tiempo total: ${tiempoTotal.toFixed(2)} segundos${colors.reset}`);
    console.log(`${colors.cyan}════════════════════════════════════${colors.reset}`);
    
  } catch (error) {
    console.error(`${colors.red}❌ Error crítico:${colors.reset}`, error);
    throw error;
  }
}

// ============================================================
// 🚀 EJECUCIÓN PRINCIPAL
// ============================================================
async function main() {
  console.log(`${colors.cyan}🧹 SCRIPT DE LIMPIEZA DE FIREBASE${colors.reset}`);
  console.log(`${colors.gray}Presiona Ctrl+C para cancelar${colors.reset}\n`);
  
  // Inicializar Firebase
  const inicializado = await inicializarFirebase();
  if (!inicializado) {
    console.error(`${colors.red}❌ No se pudo inicializar Firebase. Saliendo...${colors.reset}`);
    process.exit(1);
  }
  
  const db = admin.firestore();
  
  // Verificar argumentos
  const args = process.argv.slice(2);
  
  if (args.includes('--verificar') || args.includes('-v')) {
    await verificarUsuarios(db);
  } else if (args.includes('--reparar') || args.includes('-r')) {
    await limpiarUsuarios(db);
  } else {
    const verificacion = await verificarUsuarios(db);
    
    if (verificacion.total > 0) {
      console.log(`\n${colors.yellow}❓ ¿Deseas reparar estos usuarios? (si/no)${colors.reset}`);
      
      process.stdin.once('data', async (data) => {
        const respuesta = data.toString().trim().toLowerCase();
        if (respuesta === 'si' || respuesta === 's') {
          await limpiarUsuarios(db);
        } else {
          console.log(`${colors.gray}Limpieza cancelada${colors.reset}`);
        }
        process.exit();
      });
    } else {
      console.log(`\n${colors.green}✅ Todo OK. No hay usuarios que reparar.${colors.reset}`);
      process.exit();
    }
  }
}

// Ejecutar
main().catch(console.error);