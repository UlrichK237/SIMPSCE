from django.apps import AppConfig


class CoreConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'core'
    verbose_name = 'Smart Maintenance'
    
    def ready(self):
        # Import des signaux au démarrage
        import core.signals