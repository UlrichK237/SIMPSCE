"""
Commande Django pour initialiser les données de démonstration
Usage: python manage.py init_data
"""

from django.core.management.base import BaseCommand
from django.utils import timezone
from datetime import timedelta
from core.models import *


class Command(BaseCommand):
    help = 'Initialise les données de démonstration pour Smart Maintenance'

    def handle(self, *args, **kwargs):
        self.stdout.write('Création des données de démonstration...')
        
        # 1. Créer les utilisateurs
        self.create_users()
        
        # 2. Créer les équipements
        self.create_equipments()
        
        # 3. Créer les capteurs
        self.create_sensors()
        
        # 4. Créer les paramètres système
        self.create_settings()
        
        # 5. Créer des alarmes de démonstration
        self.create_demo_alarms()
        
        # 6. Créer des ordres de travail
        self.create_demo_work_orders()
        
        self.stdout.write(self.style.SUCCESS('Données initialisées avec succès !'))
    
    def create_users(self):
        self.stdout.write('  → Création des utilisateurs...')
        
        users_data = [
            {
                'username': 'superviseur',
                'first_name': 'Jean',
                'last_name': 'Dupont',
                'email': 'j.dupont@industrie.com',
                'role': 'superviseur',
                'department': 'Production',
                'password': 'password'
            },
            {
                'username': 'maintenance',
                'first_name': 'Koffi',
                'last_name': 'Amadou',
                'email': 'k.amadou@industrie.com',
                'role': 'maintenance',
                'department': 'Maintenance',
                'password': 'password'
            },
            {
                'username': 'operateur',
                'first_name': 'Paul',
                'last_name': 'Martin',
                'email': 'p.martin@industrie.com',
                'role': 'operateur',
                'department': 'Production',
                'password': 'password'
            },
        ]
        
        for data in users_data:
            if not User.objects.filter(username=data['username']).exists():
                password = data.pop('password')
                user = User.objects.create(**data)
                user.set_password(password)
                user.save()
                self.stdout.write(f'    ✓ {user.username}')
    
    def create_equipments(self):
        self.stdout.write('  → Création des équipements...')
        
        equipments_data = [
            {
                'name': 'Remplisseuse',
                'equipment_type': 'remplisseuse',
                'station_number': '#1',
                'status': 'en_marche',
                'temp_threshold': 60.0,
                'temp_critical': 75.0,
                'pressure_threshold': 5.5,
                'pressure_critical': 7.0,
                'vibration_threshold': 4.5,
                'vibration_critical': 6.0,
                'current_threshold': 12.0,
                'current_critical': 15.0,
                'total_operating_hours': 1240.5,
                'last_maintenance_date': timezone.now() - timedelta(days=13),
                'next_maintenance_date': timezone.now() + timedelta(days=17),
                'maintenance_frequency_days': 30,
            },
            {
                'name': 'Compresseur d\'air',
                'equipment_type': 'compresseur',
                'station_number': '#2',
                'status': 'alerte',
                'temp_threshold': 70.0,
                'temp_critical': 85.0,
                'pressure_threshold': 7.5,
                'pressure_critical': 9.0,
                'vibration_threshold': 4.5,
                'vibration_critical': 6.0,
                'current_threshold': 15.0,
                'current_critical': 18.0,
                'total_operating_hours': 2850.0,
                'last_maintenance_date': timezone.now() - timedelta(days=18),
                'next_maintenance_date': timezone.now() + timedelta(days=12),
                'maintenance_frequency_days': 30,
            },
            {
                'name': 'Convoyeur',
                'equipment_type': 'convoyeur',
                'station_number': '#3',
                'status': 'en_marche',
                'temp_threshold': 50.0,
                'temp_critical': 65.0,
                'speed_threshold': 1.5,
                'speed_critical': 1.8,
                'vibration_threshold': 3.0,
                'vibration_critical': 4.5,
                'current_threshold': 10.0,
                'current_critical': 12.0,
                'total_operating_hours': 3100.0,
                'last_maintenance_date': timezone.now() - timedelta(days=8),
                'next_maintenance_date': timezone.now() + timedelta(days=37),
                'maintenance_frequency_days': 45,
            },
        ]
        
        for data in equipments_data:
            Equipment.objects.get_or_create(
                name=data['name'],
                defaults=data
            )
            self.stdout.write(f'    ✓ {data["name"]}')
    
    def create_sensors(self):
        self.stdout.write('  → Création des capteurs...')
        
        remplisseuse = Equipment.objects.get(equipment_type='remplisseuse')
        compresseur = Equipment.objects.get(equipment_type='compresseur')
        convoyeur = Equipment.objects.get(equipment_type='convoyeur')
        
        sensors_data = [
            # Remplisseuse
            {'name': 'Température Remplisseuse', 'sensor_type': 'temperature', 'model': 'DS18B20', 'equipment': remplisseuse, 'pin_esp32': 'GPIO4', 'unit': '°C'},
            {'name': 'Pression Remplisseuse', 'sensor_type': 'pressure', 'model': 'MPX5700', 'equipment': remplisseuse, 'pin_esp32': 'GPIO34', 'unit': 'bar'},
            {'name': 'Vibration Remplisseuse', 'sensor_type': 'vibration', 'model': 'SW-420', 'equipment': remplisseuse, 'pin_esp32': 'GPIO18', 'unit': 'mm/s'},
            {'name': 'Courant Remplisseuse', 'sensor_type': 'current', 'model': 'ACS712', 'equipment': remplisseuse, 'pin_esp32': 'GPIO35', 'unit': 'A'},
            
            # Compresseur
            {'name': 'Température Compresseur', 'sensor_type': 'temperature', 'model': 'DS18B20', 'equipment': compresseur, 'pin_esp32': 'GPIO5', 'unit': '°C'},
            {'name': 'Pression Compresseur', 'sensor_type': 'pressure', 'model': 'MPX5700', 'equipment': compresseur, 'pin_esp32': 'GPIO32', 'unit': 'bar'},
            {'name': 'Courant Compresseur', 'sensor_type': 'current', 'model': 'ACS712', 'equipment': compresseur, 'pin_esp32': 'GPIO33', 'unit': 'A'},
            {'name': 'Niveau Huile', 'sensor_type': 'level', 'model': 'FLOAT_SWITCH', 'equipment': compresseur, 'pin_esp32': 'GPIO19', 'unit': '%'},
            
            # Convoyeur
            {'name': 'Vitesse Convoyeur', 'sensor_type': 'speed', 'model': 'IR_SENSOR', 'equipment': convoyeur, 'pin_esp32': 'GPIO21', 'unit': 'm/s'},
            {'name': 'Vibration Convoyeur', 'sensor_type': 'vibration', 'model': 'SW-420', 'equipment': convoyeur, 'pin_esp32': 'GPIO22', 'unit': 'mm/s'},
            {'name': 'Courant Convoyeur', 'sensor_type': 'current', 'model': 'ACS712', 'equipment': convoyeur, 'pin_esp32': 'GPIO25', 'unit': 'A'},
        ]
        
        for data in sensors_data:
            Sensor.objects.get_or_create(
                name=data['name'],
                defaults=data
            )
            self.stdout.write(f'    ✓ {data["name"]}')
    
    def create_settings(self):
        self.stdout.write('  → Création des paramètres système...')
        SystemSettings.get_settings()
        self.stdout.write('    ✓ Paramètres initialisés')
    
    def create_demo_alarms(self):
        self.stdout.write('  → Création des alarmes de démonstration...')
        
        compresseur = Equipment.objects.get(equipment_type='compresseur')
        remplisseuse = Equipment.objects.get(equipment_type='remplisseuse')
        convoyeur = Equipment.objects.get(equipment_type='convoyeur')
        
        alarms_data = [
            {
                'title': 'SurTempérature Compresseur',
                'description': 'Température du compresseur d\'air dépasse le seuil critique (78.5°C > 75°C)',
                'equipment': compresseur,
                'severity': 'critical',
                'status': 'active',
                'triggered_value': 78.5,
                'threshold_value': 75.0,
            },
            {
                'title': 'Surcharge Courant Remplisseuse',
                'description': 'Consommation électrique anormale détectée (15.2A > 12A max)',
                'equipment': remplisseuse,
                'severity': 'critical',
                'status': 'active',
                'triggered_value': 15.2,
                'threshold_value': 12.0,
            },
            {
                'title': 'Vibration Élevée Convoyeur',
                'description': 'Niveau de vibration supérieur à la moyenne (2.5 mm/s)',
                'equipment': convoyeur,
                'severity': 'warning',
                'status': 'active',
                'triggered_value': 2.5,
                'threshold_value': 3.0,
            },
        ]
        
        for data in alarms_data:
            if not Alarm.objects.filter(title=data['title'], status='active').exists():
                Alarm.objects.create(**data)
                self.stdout.write(f'    ✓ {data["title"]}')
    
    def create_demo_work_orders(self):
        self.stdout.write('  → Création des ordres de travail...')
        
        remplisseuse = Equipment.objects.get(equipment_type='remplisseuse')
        compresseur = Equipment.objects.get(equipment_type='compresseur')
        convoyeur = Equipment.objects.get(equipment_type='convoyeur')
        maintenance_user = User.objects.get(role='maintenance')
        superviseur = User.objects.get(role='superviseur')
        
        wos_data = [
            {
                'title': 'Maintenance Préventive Remplisseuse',
                'description': 'Lubrification et contrôle des joints',
                'equipment': remplisseuse,
                'wo_type': 'preventive',
                'priority': 'normal',
                'status': 'in_progress',
                'assigned_to': maintenance_user,
                'created_by': superviseur,
                'planned_date': timezone.now() + timedelta(days=2),
            },
            {
                'title': 'Correction SurTempérature Compresseur',
                'description': 'Vérification système refroidissement',
                'equipment': compresseur,
                'wo_type': 'corrective',
                'priority': 'urgent',
                'status': 'planned',
                'created_by': superviseur,
                'planned_date': timezone.now(),
            },
            {
                'title': 'Inspection Vibration Convoyeur',
                'description': 'Analyse spectre vibration et ajustement',
                'equipment': convoyeur,
                'wo_type': 'predictive',
                'priority': 'high',
                'status': 'planned',
                'assigned_to': maintenance_user,
                'created_by': superviseur,
                'planned_date': timezone.now() + timedelta(days=1),
            },
        ]
        
        for data in wos_data:
            if not WorkOrder.objects.filter(title=data['title']).exists():
                WorkOrder.objects.create(**data)
                self.stdout.write(f'    ✓ {data["title"]}')