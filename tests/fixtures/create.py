# Original synthetic schedule, dedicated to this project's MIT license.
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED, ZipInfo
files = {
'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\na,Synthetic Transit,https://example.org,Europe/Zurich\n',
'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station,platform_code\nA,Alpha,46.5,6.5,0,,\nB,Beta,46.6,6.6,0,,\nC,Gamma,46.7,6.7,0,,\nD,Isolated,46.8,6.8,0,,\nE,Alpha,46.9,6.9,0,,\n',
'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_type\nr,a,R,Regional,2\ns,a,S,Shuttle,3\n',
'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nsvc,1,1,1,1,1,1,1,20260101,20261231\n',
'calendar_dates.txt': 'service_id,date,exception_type\nsvc,20261125,2\nsvc,20270101,1\n',
' trips.txt': '',
}
files.pop(' trips.txt')
files['trips.txt']='route_id,service_id,trip_id\nr,svc,slow\nr,svc,fast\ns,svc,connection\nr,svc,night\n'
files['stop_times.txt']='trip_id,arrival_time,departure_time,stop_id,stop_sequence\nslow,08:05:00,08:05:00,A,1\nslow,08:50:00,08:50:00,B,2\nfast,08:30:00,08:30:00,A,1\nfast,08:55:00,08:55:00,B,2\nconnection,08:58:00,08:58:00,B,1\nconnection,09:10:00,09:10:00,C,2\nnight,24:10:00,24:10:00,A,1\nnight,24:30:00,24:30:00,B,2\n'
files['stops.txt'] += 'P,Hub,47,7,1,,\nP1,Hub Platform 1,47,7,0,P,1\nP2,Hub Platform 2,47,7,0,P,2\n'
files['trips.txt'] += 'r,svc,hub\n'
files['stop_times.txt'] += 'hub,10:05:00,10:05:00,P1,1\nhub,10:15:00,10:15:00,B,2\n'
files['transfers.txt'] = 'from_stop_id,to_stop_id,transfer_type,min_transfer_time\nP1,P2,2,120\n'
with ZipFile(Path(__file__).with_name('tiny.zip'),'w',ZIP_DEFLATED) as archive:
 for name,content in files.items(): archive.writestr(ZipInfo(name, (2026, 1, 1, 0, 0, 0)),content)
