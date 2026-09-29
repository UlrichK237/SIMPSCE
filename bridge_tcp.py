#!/usr/bin/env python3
"""
Bridge TCP -> WebSocket - Smart Maintenance
"""

import socket
import json
import websocket
import threading
import time
import logging

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

# === CONFIGURATION ===
PROTEUS_IP = "192.168.1.178"
PROTEUS_PORT = 5555
WS_URL = "ws://localhost:8000/ws/dashboard/"

# === WebSocket ===
ws = None

def on_ws_open(ws_conn):
    logger.info("WebSocket connecté")
    ws_conn.send(json.dumps({"type": "hello", "source": "bridge"}))

def on_ws_message(ws_conn, message):
    logger.info(f"WS reçu: {message}")

def on_ws_error(ws_conn, error):
    logger.error(f"WS erreur: {error}")

def on_ws_close(ws_conn, close_status_code, close_msg):
    logger.warning(f"WS fermé: {close_status_code} - {close_msg}")

def connect_websocket():
    global ws
    ws = websocket.WebSocketApp(
        WS_URL,
        on_open=on_ws_open,
        on_message=on_ws_message,
        on_error=on_ws_error,
        on_close=on_ws_close
    )
    wst = threading.Thread(target=ws.run_forever)
    wst.daemon = True
    wst.start()
    time.sleep(2)  # Attendre connexion

# === TCP ===
def read_tcp_data(sock):
    """Lire les données du socket TCP de manière non-bloquante"""
    try:
        sock.settimeout(1.0)
        data = sock.recv(4096)
        if data:
            return data.decode('utf-8', errors='ignore')
        return None
    except socket.timeout:
        return None
    except Exception as e:
        logger.error(f"Erreur lecture TCP: {e}")
        return None

def main():
    logger.info("=" * 60)
    logger.info("SMART MAINTENANCE - BRIDGE TCP <-> DJANGO")
    logger.info("=" * 60)
    
    # Connexion WebSocket
    logger.info(f"Connexion WebSocket à {WS_URL}...")
    connect_websocket()
    
    # Connexion TCP
    logger.info(f"Connexion TCP à {PROTEUS_IP}:{PROTEUS_PORT}...")
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.connect((PROTEUS_IP, PROTEUS_PORT))
        logger.info("TCP connecté!")
    except Exception as e:
        logger.error(f"Impossible de connecter TCP: {e}")
        return
    
    # Buffer pour accumuler les données
    buffer = ""
    
    logger.info("Bridge opérationnel!")
    
    while True:
        # Lire données TCP
        data = read_tcp_data(sock)
        if data:
            buffer += data
            logger.info(f"Données TCP reçues ({len(data)} bytes): {data[:100]}...")
            
            # Traiter les lignes complètes (terminées par \n)
            lines = buffer.split('\n')
            buffer = lines[-1]  # Garder le reste incomplet
            
            for line in lines[:-1]:
                line = line.strip()
                if line:
                    logger.info(f"Ligne JSON: {line[:200]}")
                    # Envoyer au WebSocket
                    if ws and ws.sock and ws.sock.connected:
                        try:
                            # Vérifier que c'est du JSON valide
                            json.loads(line)
                            ws.send(line)
                            logger.info("-> Forwardé vers WebSocket")
                        except json.JSONDecodeError:
                            logger.warning(f"Données non-JSON ignorées: {line[:100]}")
                    else:
                        logger.warning("WebSocket non connecté, données perdues")
        
        time.sleep(0.01)  # 10ms pour ne pas surcharger le CPU

if __name__ == "__main__":
    main()