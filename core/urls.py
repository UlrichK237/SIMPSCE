"""
URLs de l'application Core - Smart Maintenance
"""

from django.urls import path
from django.views.generic import TemplateView

urlpatterns = [
    # Page principale (Single Page Application)
    path('', TemplateView.as_view(template_name='index.html'), name='home'),
    
    # Catch-all pour le routing côté client
    path('<path:path>', TemplateView.as_view(template_name='index.html')),
]