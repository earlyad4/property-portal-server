"use strict";
// A loopback-only, read-only UI preview. Synthetic fixtures, no database or external services.
const http = require('node:http');
const stamp = '2026-10-01T10:00:00.000Z';
const tenant = { id:'DEMO-RESIDENT', name:'Demo Resident', email:'resident@example.com', phone:null, buildingId:'DEMO-BUILDING', unit:'101' };
const building = { id:'DEMO-BUILDING', code:'DEMO', name:'Example Residence', address:'Sample district', units:24, floors:4, emirate:null };
const tickets = [
  { id:'REQ-001', title:'Air conditioning service', category:'AC', description:'The living room air conditioner needs a routine inspection.', status:'Pending' },
  { id:'REQ-002', title:'Kitchen tap repair', category:'Plumbing', description:'Please check the kitchen tap for a slow drip.', status:'Assigned' },
  { id:'REQ-003', title:'Hallway lighting', category:'Electrical', description:'Replace the hallway light fixture.', status:'Completed' },
].map(t=>({...t,tenantId:tenant.id,buildingId:building.id,buildingName:building.name,unit:'101',priority:'Normal',submittedAt:stamp,updated_at:stamp,updatedAt:stamp,timeline:[]}));
const broadcasts = [{id:'NOTICE-001',buildingId:building.id,buildingName:building.name,title:'Scheduled building maintenance',message:'Common area inspections are planned for Saturday, 9 am to noon. Thank you for your cooperation.',createdAt:stamp,dismissedBy:[]}];
const bootstrap = {tenant,building,maintenanceRequests:tickets,documents:[],qualityReports:[],reviews:[],broadcasts};
const fixtures = {
 '/api/public/buildings':{buildings:[building]},
 '/api/auth/tenant/login':{tenant,accessToken:'synthetic-preview-token',refreshToken:'synthetic-preview-refresh',expiresAt:0},
 '/api/auth/admin/login':{token:'synthetic-preview-admin',admin:{id:'DEMO-OPERATOR',name:'Demo Operator',email:'operator@example.com',role:'admin'}},
 '/api/auth/admin/me':{admin:{id:'DEMO-OPERATOR',name:'Demo Operator',email:'operator@example.com',role:'admin'}},
 '/api/auth/tenant/me':{tenant},
 '/api/mobile/bootstrap':bootstrap,
 '/api/dashboard/stats':{buildings:1,tenants:24,openTickets:2,resolvedThisMonth:1,technicians:3,activeTechnicians:2,qualityScore:4.8,reviewsCount:12,recentTickets:tickets,recentBroadcasts:broadcasts},
 '/api/dashboard/tickets':{tickets},
 '/api/dashboard/buildings':{buildings:[building]},
 '/api/dashboard/tenants':{tenants:[]},
 '/api/dashboard/technicians':{technicians:[]},
 '/api/dashboard/documents':{documents:[]},
 '/api/dashboard/quality-reports':{reports:[]},
};
http.createServer((req,res)=>{
 const origin=req.headers.origin;
 if(origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)){res.writeHead(403);return res.end();}
 res.setHeader('Access-Control-Allow-Origin',origin || 'http://localhost:5173');
 res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Property-Portal-Client, X-Property-Portal-Version');
 res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
 res.setHeader('Cache-Control','no-store');
 if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
 const pathname=new URL(req.url,'http://localhost').pathname;
 const fixture=fixtures[pathname];
 const login=pathname==='/api/auth/tenant/login'||pathname==='/api/auth/admin/login';
 const allowed=fixture && (req.method==='GET'||(req.method==='POST'&&login));
 res.writeHead(allowed?200:405,{'Content-Type':'application/json'});
 res.end(JSON.stringify(allowed?fixture:{error:'Read-only synthetic preview: this action is unavailable.'},null,2));
}).listen(4318,'127.0.0.1',()=>console.log('Synthetic UI preview at http://127.0.0.1:4318 — no database, persistence, email or push.'));
