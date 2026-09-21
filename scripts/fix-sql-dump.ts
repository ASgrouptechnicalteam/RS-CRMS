import * as fs from 'fs';
import * as path from 'path';

const sqlFilePath = path.join(__dirname, '../../../docs/u988844918_RS_DB.sql');
let sqlContent = fs.readFileSync(sqlFilePath, 'utf8');

// Replace malformed "Today's" with escaped "Today''s"
sqlContent = sqlContent.replace(/Today's/g, "Today''s");

fs.writeFileSync(sqlFilePath, sqlContent, 'utf8');
console.log('Fixed malformed quotes in SQL dump.');
