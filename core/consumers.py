"""
WebSocket Consumers - Smart Maintenance
Temps réel pour dashboard et supervision
"""

import json
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from django.utils import timezone


class DashboardConsumer(AsyncWebsocketConsumer):
    """
    Consumer pour le tableau de bord global
    Diffusion des mises à jour générales
    """
    
    async def connect(self):
       self.room_group_name = 'dashboard'
       await self.channel_layer.group_add(
          self.room_group_name,
          self.channel_name
       )
       await self.accept()
    
    async def disconnect(self, close_code):
        await self.channel_layer.group_discard(
            self.room_group_name,
            self.channel_name
        )
    
    async def receive(self, text_data):
        """Réception de messages du client"""
        data = json.loads(text_data)
        message_type = data.get('type', '')
        
        if message_type == 'ping':
            await self.send(text_data=json.dumps({
                'type': 'pong',
                'timestamp': str(timezone.now())
            }))
    
    async def sensor_data(self, event):
        """Recevoir les données capteurs du groupe"""
        await self.send(text_data=json.dumps({
            'type': 'sensor_update',
            'data': event['readings']
        }))
    
    async def alarm_update(self, event):
        """Recevoir les mises à jour d'alarmes"""
        await self.send(text_data=json.dumps({
            'type': 'alarm_update',
            'data': event['message']
        }))
    
    async def dashboard_update(self, event):
        """Mise à jour générale du dashboard"""
        await self.send(text_data=json.dumps({
            'type': 'dashboard_update',
            'equipment_id': event.get('equipment_id')
        }))


class EquipmentConsumer(AsyncWebsocketConsumer):
    """
    Consumer par équipement pour supervision détaillée
    """
    
    async def connect(self):
       self.equipment_id = self.scope['url_route']['kwargs']['equipment_id']
       self.room_group_name = f'equipment_{self.equipment_id}'
       await self.channel_layer.group_add(
         self.room_group_name,
         self.channel_name
       )
       await self.accept()
    
    async def disconnect(self, close_code):
        await self.channel_layer.group_discard(
            self.room_group_name,
            self.channel_name
        )
    
    async def receive(self, text_data):
        data = json.loads(text_data)
        # Traiter les commandes si nécessaire
    
    async def sensor_data(self, event):
        """Recevoir les données capteurs spécifiques à l'équipement"""
        await self.send(text_data=json.dumps({
            'type': 'sensor_data',
            'data': event['readings']
        }))


class AlarmsConsumer(AsyncWebsocketConsumer):
    """
    Consumer dédié aux alarmes
    """
    
    async def connect(self):
       self.room_group_name = 'alarms'
       await self.channel_layer.group_add(
          self.room_group_name,
          self.channel_name
       )
       await self.accept()
    
    async def disconnect(self, close_code):
        await self.channel_layer.group_discard(
            self.room_group_name,
            self.channel_name
        )
    
    async def alarm_update(self, event):
        await self.send(text_data=json.dumps({
            'type': 'alarm_update',
            'data': event['message']
        }))