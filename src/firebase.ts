import { initializeApp } from "firebase/app"
import { getFirestore } from "firebase/firestore"
import { getAuth, GoogleAuthProvider } from "firebase/auth"

const firebaseConfig = {
  apiKey: "AIzaSyAW4f9n9tNXHpKMtoTZ0RiteIy5T4MVTMs",
  authDomain: "bageecha-421c1.firebaseapp.com",
  projectId: "bageecha-421c1",
  storageBucket: "bageecha-421c1.firebasestorage.app",
  messagingSenderId: "96231101172",
  appId: "1:96231101172:web:c4e2ec80625b1d625884a1",
}

export const app = initializeApp(firebaseConfig)
export const db = getFirestore(app)
export const auth = getAuth(app)
export const googleProvider = new GoogleAuthProvider()

export const ADMIN_EMAIL = "chevplayz@gmail.com"
