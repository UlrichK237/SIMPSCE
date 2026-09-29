"""
Configuration ASGI - Smart Maintenance
Support WebSocket avec Channels
"""

import os
from django.core.asgi import get_asgi_application
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack


os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'smart_maintenance.settings')

# Importer le routage après avoir défini DJANGO_SETTINGS_MODULE
import core.routing

application = ProtocolTypeRouter({
    "http": get_asgi_application(),
    "websocket": AuthMiddlewareStack(
            URLRouter(
                core.routing.websocket_urlpatterns
            )
        ),
})