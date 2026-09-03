// Check tables in test_db via direct MySQL connection
const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection({
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: '',
    database: 'test_db'
  });
  
  const [tables] = await conn.query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='test_db' ORDER BY TABLE_NAME"
  );
  
  console.log(`Found ${tables.length} tables:`);
  tables.forEach(t => console.log(`  - ${t.TABLE_NAME}`));
  
  await conn.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
