import chromadb

# Start the ChromaDB server
chroma_client = chromadb.PersistentClient(path="./chroma_db")  # Local storage
print("✅ ChromaDB server is running at http://localhost:8000")

# Keep the script running
import time
while True:
    time.sleep(10)
