"""
Routage WebSocket - Smart Maintenance
"""

from django.urls import re_path
from . import consumers

websocket_urlpatterns = [
    # Dashboard global
    re_path(r'ws/dashboard/$', consumers.DashboardConsumer.as_asgi()),
    
    # Supervision par équipement
    re_path(r'ws/equipment/(?P<equipment_id>\d+)/$', consumers.EquipmentConsumer.as_asgi()),
    
    # Flux d'alarmes
    re_path(r'ws/alarms/$', consumers.AlarmsConsumer.as_asgi()),
]