const mongoose = require("mongoose");
let db;
const connectDatabase = async () => {
    db = await mongoose
        .connect(process.env.MONGO_URL, {

        })
        .then((data) => {
            console.log(`mongod connected with server: ${data.connection.host}`);
        }); 
        
};



module.exports = { connectDatabase, db };